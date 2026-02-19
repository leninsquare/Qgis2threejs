// (C) 2017 Minoru Akagi
// SPDX-License-Identifier: MIT

Q3D.Config.preview = {

	// showTriangleCount: debug_mode,

	showFPS: false

};

var viewerScript = document.currentScript;
var viewerScriptSrc = (viewerScript && viewerScript.src) ? viewerScript.src : "";
Q3D.Config.potree.basePath = viewerScriptSrc ? (viewerScriptSrc + "/../../js/potree-core") : "../js/potree-core";
console.log("[Q3D] viewer.js loading", {src: viewerScriptSrc});


Q3D.Config.potree.maxNodesLoading = 1;

var app = Q3D.application,
	gui = Q3D.gui;

var preview = {

	renderEnabled: true,

	noRenderDuringLoad: true,	// whether to suppress rendering while data is loading

	isDataLoading: false,		// indicates whether scene/layer/block data sent from Python (such as scene/layer properties,
								// DEM grids, feature geometries, and images) is being loaded; if block data includes image data,
								// it remains true until the images have been loaded as textures.

	timer: {
		tickCount: 0
	}
};

//// initialization
function init(off_screen, debug_mode, qgis_version, is_webengine) {
	console.log("[Q3D] init", {off_screen: off_screen, debug_mode: debug_mode, qgis_version: qgis_version, is_webengine: is_webengine});

	Q3D.Config.debugMode = debug_mode;
	Q3D.Config.qgisVersion = qgis_version;
	Q3D.Config.isWebEngine = is_webengine;

	if (is_webengine) {
		// Web Channel
		new QWebChannel(qt.webChannelTransport, function(channel) {
			window.pyObj = channel.objects.bridge;
			pyObj.sendData.connect(function (data, viaQueue) {
				loadData(data, viaQueue);

				if (Q3D.Config.debugMode) {
					var dataType = data.type || "unknown";
					console.debug("↓" + dataType + " data loaded", data);
				}
			});

			_init(off_screen);

		});
	}
	else {
		// WebKit Bridge
		window.pyData = function () {
			return pyObj.data();
		}

		_init(off_screen);

	}
}

function _init(off_screen) {
	console.log("[Q3D] _init", {off_screen: off_screen});

	var container = Q3D.E("view");
	app.init(container);

	if (off_screen) {
		Q3D.E("progress").style.display = "none";
		var renderOffscreen = app.render;
		app.render = function () {};		// No need to render the scene before it has fully loaded.
		app.addEventListener("sceneLoaded", function () {
			app.render = renderOffscreen;
			app.render(true);
		});
	}
	else {
		Q3D.E("closemsgbar").onclick = closeMessageBar;
	}

	app.addEventListener("loadComplete", function () {
		console.log("[Q3D] loadComplete");

		preview.isDataLoading = false;

		setTimeout(function () {
			app.render(true);
			pyObj.emitDataLoaded();
		}, 0);
	});

	app.addEventListener("loadError", function () {
		pyObj.emitDataLoadError();
	});

	app.addEventListener("sceneLoaded", function () {
		console.log("[Q3D] sceneLoaded");

		pyObj.emitSceneLoaded();
	});

	app.addEventListener("tweenStarted", function (e) {
		pyObj.emitTweenStarted(e.index);
	});

	app.addEventListener("animationStopped", function () {
		pyObj.emitAnimationStopped();
	});

	if (Q3D.Config.debugMode) {
		showTriangleCount();
	}

	if (Q3D.Config.preview.showFPS) {
		showFPS();
	}

	// check extension support of web view
	// see https://github.com/minorua/Qgis2threejs/issues/147
	var gl = app.renderer.getContext();		// WebGLRenderingContext
	if (gl.getExtension("WEBGL_depth_texture") === null) {

		var viewName = (Q3D.Config.isWebEngine) ? "WebEngine" : "WebKit";

		var msg = "The current web view (Qt " + viewName + ") cannot display 3D objects. ";

		if (!Q3D.Config.isWebEngine) {

			if (Q3D.Config.qgisVersion >= 33600) {

				msg += "Please use the Qt WebEngine view instead. You can find instructions on how to do this in the plugin ";
				msg += "<a href='https://github.com/minorua/Qgis2threejs/wiki/How-to-use-Qt-WebEngine-view-with-Qgis2threejs'>wiki</a>.";

			}
			else {

				msg += "Please consider using QGIS version 3.36 or a later version, which supports using Qt WebEngine view.";

			}
		}

		showMessageBar(msg, undefined, true);
	}
	initCameraInputControls();
	initScreenshotInputControls();
	captureScreenshotSeries();
	pyObj.emitInitialized();
}

//// load functions
var appLoadDataTypes = ["scene", "layer", "block"];

function loadData(data, viaQueue) {
	if (Q3D.Config.debugMode) {
		console.debug("Loading " + (data.type || "unknown") + " data...");
	}

	if (viaQueue) {
		preview.isDataLoading = true;
		app.loadingManager.itemStart("data");
	}

	if (appLoadDataTypes.includes(data.type)) {
		if (data.type == "scene" && data.properties !== undefined) {
			_requestCameraUpdate(data.properties);
		}
		app.loadData(data);

		if (data.progress !== undefined) {
			updateProgressBar(data.progress);
		}
	}
	else if (data.type == "signal") {
		if (data.name == "queueCompleted") {
			tasksAndLoadingFinalized(data.success, data.is_scene);
		}
	}
	else if (data.type == "labels") {
		Q3D.E("header").innerHTML = data.Header || "";
		Q3D.E("footer").innerHTML = data.Footer || "";
	}
	else if (data.type == "cameraState") {
		setCameraState(data.state);
	}
	else if (data.type == "animation") {
		startAnimation(data.tracks, data.repeat);
	}
	else if (data.type == "narration") {
		showNarrativeBox(data.content);
	}

	if (viaQueue) {
		app.loadingManager.itemEnd("data");
	}
}

function _requestCameraUpdate(sp) {
	// update camera position - keep relative position to base extent
	var lastP = app.scene.userData,
		lastBE = lastP.baseExtent;
	if (lastBE === undefined) return;

	var be = sp.baseExtent,
		v0 = new THREE.Vector3(lastBE.cx, lastBE.cy, 0).sub(lastP.origin),
		v1 = new THREE.Vector3(be.cx, be.cy, 0).sub(sp.origin),
		s = be.width / lastBE.width;

	var pos = new THREE.Vector3().copy(app.camera.position).sub(v0).multiplyScalar(s).add(v1),
		focal = new THREE.Vector3().copy(app.controls.target).sub(v0).multiplyScalar(s).add(v1);

	var near, far;
	if (s != 1) {
		near = 0.001 * be.width;
		far = 100 * be.width;
	}
	app.scene.requestCameraUpdate(pos, focal, near, far);
}

function loadScriptFile(path, callback) {
	var url = new URL(path, document.baseURI);

	var elms = document.head.getElementsByTagName("script");
	for (var i = 0; i < elms.length; i++) {
		if (elms[i].src == url) {
			if (callback) callback();
			return false;
		}
	}

	var s = document.createElement("script");
	s.src = url;
	if (callback) s.onload = callback;
	document.head.appendChild(s);
	return true;
}

function loadModel(url) {

	var loadToScene = function (res) {
		var boxsize = new THREE.Box3().setFromObject(res.scene).getSize(),
				scale = 50 / Math.max(boxsize.x, boxsize.y, boxsize.z);

		var parent = new THREE.Group();
		parent.scale.set(scale, scale, scale);
		parent.rotation.x = Math.PI / 2;
		parent.add(res.scene);
		app.scene.add(parent);

		app.render();

		var sceneScale = app.scene.userData.scale,
			objScale = scale / sceneScale;

		console.log("Model " + url + " loaded.");
		console.log("scale: " + scale + " (obj: " + objScale + " x scene: " + sceneScale + ")");
		console.log("To clear the added object, use scene reload (F5).");

		showMessageBar('Model preview: Successfully loaded "' + url.split("/").pop() + '". See console for details.', 3000);
	};
	var onError = function (e) {
		console.warn(e.message);
		showMessageBar('Model preview: Failed to load "' + url.split("/").pop() + '". See console for details.', 5000, true);
	};

	var ext = url.split(".").pop();
	if (ext == "dae") {
		loadScriptFile("../js/lib/threejs/loaders/ColladaLoader.js", function () {
			var loader = new THREE.ColladaLoader(app.loadingManager);
			loader.load(url, loadToScene, undefined, onError);
		});
	}
	else if (ext == "gltf" || ext == "glb") {
		loadScriptFile("../js/lib/threejs/loaders/GLTFLoader.js", function () {
			var loader = new THREE.GLTFLoader(app.loadingManager);
			loader.load(url, loadToScene, undefined, onError);
		});
	}
}

function hideLayer(layerId, remove_obj) {
	var layer = app.scene.mapLayers[layerId];
	if (layer !== undefined) {
		layer.visible = false;
		if (remove_obj) layer.clearObjects();
	}
}

var progressFadeoutSet = false;
function tasksAndLoadingFinalized(success, is_scene) {
	// hide progress bar
	Q3D.E("progressbar").classList.add("fadeout");
	progressFadeoutSet = true;

	if (success && is_scene) {
		setTimeout(function () {
			app.dispatchEvent({type: "sceneLoaded"});
		}, 0);
	}
}

function updateProgressBar(loaded, total) {
	total = total || 100;
	Q3D.E("progressbar").style.width = (loaded / total * 100) + "%";
	if (progressFadeoutSet) {
		Q3D.E("progressbar").classList.remove("fadeout");
		progressFadeoutSet = false;
	}
}

function showTriangleCount() {
	window.setInterval(function () {
		var triangles = app.renderer.info.render.triangles;
		if (triangles != preview.lastTriangleCount) {
			Q3D.E("triangles").innerHTML = "Triangles: " + app.renderer.info.render.triangles.toLocaleString();
			preview.lastTriangleCount = triangles;
		}
	}, 1000);
}

function showFPS() {
	preview.timer.last = Date.now();

	window.setInterval(function () {
		var now = Date.now(),
			elapsed = now - preview.timer.last,
			fps = Math.round(preview.timer.tickCount / elapsed * 1000);

		if (fps != preview.lastFPS) {
			Q3D.E("fps").innerHTML = "FPS: " + fps;
			preview.lastFPS = fps;
		}

		preview.timer.last = now;
		preview.timer.tickCount = 0;
	}, 1000);
}

function saveModelAsGLTF(filename) {
	showStatusMessage('Saving the model to "' + filename + '"...');

	var scene = new THREE.Scene(), layer, group;
	for (var k in app.scene.mapLayers) {
		layer = app.scene.mapLayers[k];
		group = layer.objectGroup;
		group.rotation.set(-Math.PI / 2, 0, 0);
		group.name = layer.properties.name;
		scene.add(group);
	}
	scene.updateMatrixWorld();

	var options = {
		binary: (filename.split(".").pop().toLowerCase() == "glb")
	};

	var gltfExporter = new THREE.GLTFExporter();
	gltfExporter.parse(scene, function(result) {
		var showStatus = function () {
			showStatusMessage("Successfully saved the model.", 5000);
		};

		if (result instanceof ArrayBuffer) {
			sendBytes(new Uint8Array(result), filename, showStatus);
		}
		else {
			sendText(JSON.stringify(result, null, 2), filename, showStatus);
		}

		// restore preview
		for (var k in app.scene.mapLayers) {
			layer = app.scene.mapLayers[k];
			group = layer.objectGroup;
			group.rotation.set(0, 0, 0);
			app.scene.add(group);
		}
		app.scene.updateMatrixWorld();
		app.render();
	}, options);
}

function sendBytes(bytes, filename, callback) {
	sendData(true, bytes, filename, callback);
}

function sendText(text, filename, callback) {
	sendData(false, text, filename, callback);
}

function uint8ToBase64(u8) {
    let binary = "";
    for (let i = 0; i < u8.length; i++) {
        binary += String.fromCharCode(u8[i]);
    }
    return btoa(binary);
}

function sendData(is_base64, data, filename, callback) {
    const CHUNK_SIZE = 100000;
    let offset = 0;

	function sendNext() {
        if (offset >= data.length) {
			if (callback) callback();
            return;
        }

        const chunk = data.slice(offset, offset + CHUNK_SIZE);
        const isFirst = (offset === 0);
        const isLast = (offset + CHUNK_SIZE >= data.length);

		if (is_base64) {
			pyObj.saveBase64(uint8ToBase64(chunk), filename, isFirst, isLast);
		}
		else {
			pyObj.saveText(chunk, filename, isFirst, isLast);
		}

        offset += CHUNK_SIZE;

        setTimeout(sendNext, 0);
    }
    sendNext();
}

function sendImageBytes(bytes, filename, callback) {
	sendImageData(bytes, filename, callback);
}

function sendImageData(data, filename, callback) {
	const CHUNK_SIZE = 100000;
	let offset = 0;

	function sendNext() {
		if (offset >= data.length) {
			if (callback) callback();
			return;
		}

		const chunk = data.slice(offset, offset + CHUNK_SIZE);
		const isFirst = (offset === 0);
		const isLast = (offset + CHUNK_SIZE >= data.length);

		pyObj.saveImageBase64(uint8ToBase64(chunk), filename, isFirst, isLast);

		offset += CHUNK_SIZE;

		setTimeout(sendNext, 0);
	}
	sendNext();
}

function requestRendering() {
	requestAnimationFrame(function () {
		app.render(true);
		pyObj.emitRequestedRenderingFinished();
	});
}

var barTimerId = null;
function showMessageBar(message, timeout_ms, warning) {
	if (barTimerId !== null) {
		clearTimeout(barTimerId);
		barTimerId = null;
	}
	if (timeout_ms) {
		barTimerId = setTimeout(closeMessageBar, timeout_ms);
	}

	Q3D.E("msgcontent").innerHTML = message;

	var e = Q3D.E("msgbar");
	e.style.display = "block";
	if (warning) {
		e.classList.add("warning");
	}
	else {
		e.classList.remove("warning");
	}
}

function closeMessageBar() {
	Q3D.E("msgbar").style.display = "none";
	barTimerId = null;
}

function initCameraInputControls() {
	var applyBtn = Q3D.E("applycamerabtn");
	if (!applyBtn) return;

	var xInput = Q3D.E("camera_x");
	var yInput = Q3D.E("camera_y");
	var zInput = Q3D.E("camera_z");

	var parseInput = function (input, label) {
		if (!input) return {error: label + " input is missing."};
		var value = input.value.trim();
		if (!value) return {error: label + " is required."};
		var number = parseFloat(value);
		if (Number.isNaN(number)) return {error: label + " must be a number."};
		return {value: number};
	};

	applyBtn.onclick = function () {
		var xValue = parseInput(xInput, "X");
		if (xValue.error) {
			showMessageBar(xValue.error, 3000, true);
			return;
		}

		var yValue = parseInput(yInput, "Y");
		if (yValue.error) {
			showMessageBar(yValue.error, 3000, true);
			return;
		}

		var zValue = parseInput(zInput, "Z");
		if (zValue.error) {
			showMessageBar(zValue.error, 3000, true);
			return;
		}

		var target = app.scene.toMapCoordinates(app.controls.target);
		setCameraState({
			pos: {x: xValue.value, y: yValue.value, z: zValue.value},
			lookAt: {x: target.x, y: target.y, z: target.z}
		});

		if (app.controls && app.controls.saveState) {
			app.controls.saveState();
		}
		app.render();
	};

	var useCurrentBtn = Q3D.E("usecurrentcamerabtn");
	if (useCurrentBtn) {
		useCurrentBtn.onclick = function () {
			var state = cameraState(true);
			xInput.value = state.x;
			yInput.value = state.y;
			zInput.value = state.z;
		};
	}
}

function captureScreenshotSeries(cameraPos, focusPoints, outputDir, baseName, onDone) {
	console.log("[Q3D] captureScreenshotSeries", {cameraPos: cameraPos, focusPoints: focusPoints, outputDir: outputDir, baseName: baseName});

	if (!cameraPos || !focusPoints || !focusPoints.length) {
		showMessageBar("Add at least one focus point.", 3000, true);
		if (onDone) onDone();
		return;
	}
	if (!outputDir) {
		showMessageBar("Output folder is required.", 3000, true);
		if (onDone) onDone();
		return;
	}

	var base = baseName || "screenshot";
	var joinPath = function (dir, filename) {
		var separator = (dir.indexOf("\\") !== -1) ? "\\" : "/";
		if (dir.endsWith("/") || dir.endsWith("\\")) return dir + filename;
		return dir + separator + filename;
	};

	var captureNext = function (index) {
		if (index >= focusPoints.length) {
			showMessageBar("Screenshots saved to " + outputDir + ".", 3000);
			if (onDone) onDone();
			return;
		}

		setCameraState({pos: cameraPos, lookAt: focusPoints[index]});

		requestAnimationFrame(function () {
			app._saveCanvasImage(app.width, app.height, false, function (canvas) {
				var dataUrl = canvas.toDataURL("image/png");
				var bytes = Q3D.Utils.base64ToUint8Array(dataUrl.split(",")[1]);
				var filename = joinPath(outputDir, base + "_" + (index + 1) + ".png");
				sendImageBytes(bytes, filename, function () {
					captureNext(index + 1);
				});
			});
		});
	};

	captureNext(0);
};
console.log("[Q3D] captureScreenshotSeries defined", typeof captureScreenshotSeries);

function initScreenshotInputControls() {
	var captureBtn = Q3D.E("capturescreenshotsbtn");
	if (!captureBtn) return;
	console.log("[Q3D] initScreenshotInputControls");

	var cameraXInput = Q3D.E("screenshot_camera_x");
	var cameraYInput = Q3D.E("screenshot_camera_y");
	var cameraZInput = Q3D.E("screenshot_camera_z");
	var outputDirInput = Q3D.E("screenshot_output_dir");
	var baseNameInput = Q3D.E("screenshot_basename");
	var focusList = Q3D.E("screenshot_focus_list");
	var addFocusBtn = Q3D.E("addfocusbtn");
	var useCurrentCameraBtn = Q3D.E("usecurrentscreenshotcamerabtn");
	var useCurrentFocusBtn = Q3D.E("usecurrentfocusbtn");

	var parseInput = function (input, label) {
		if (!input) return {error: label + " input is missing."};
		var value = input.value.trim();
		if (!value) return {error: label + " is required."};
		var number = parseFloat(value);
		if (Number.isNaN(number)) return {error: label + " must be a number."};
		return {value: number};
	};

	var joinPath = function (dir, filename) {
		var separator = (dir.indexOf("\\") !== -1) ? "\\" : "/";
		if (dir.endsWith("/") || dir.endsWith("\\")) return dir + filename;
		return dir + separator + filename;
	};

	var addFocusRow = function (values) {
		if (!focusList) return;

		var row = document.createElement("div");
		row.className = "screenshot-focus-row";

		var createNumberInput = function (placeholder, value) {
			var input = document.createElement("input");
			input.type = "number";
			input.step = "any";
			input.placeholder = placeholder;
			input.className = "camera-input";
			if (value !== undefined) input.value = value;
			return input;
		};

		var xInput = createNumberInput("FX", values && values.x);
		var yInput = createNumberInput("FY", values && values.y);
		var zInput = createNumberInput("FZ", values && values.z);

		var removeBtn = document.createElement("button");
		removeBtn.type = "button";
		removeBtn.className = "action-btn screenshot-remove-btn";
		removeBtn.innerHTML = "×";
		removeBtn.onclick = function () {
			focusList.removeChild(row);
		};

		row.appendChild(xInput);
		row.appendChild(yInput);
		row.appendChild(zInput);
		row.appendChild(removeBtn);
		focusList.appendChild(row);
	};

	if (addFocusBtn) {
		addFocusBtn.onclick = function () {
			addFocusRow();
		};
	}

	if (useCurrentFocusBtn) {
		useCurrentFocusBtn.onclick = function () {
			var state = cameraState(true);
			addFocusRow({x: state.fx, y: state.fy, z: state.fz});
		};
	}

	if (useCurrentCameraBtn) {
		useCurrentCameraBtn.onclick = function () {
			var state = cameraState(true);
			cameraXInput.value = state.x;
			cameraYInput.value = state.y;
			cameraZInput.value = state.z;
		};
	}

	captureBtn.onclick = function () {
		if (!outputDirInput || !baseNameInput || !focusList) return;

		var xValue = parseInput(cameraXInput, "Camera X");
		if (xValue.error) {
			showMessageBar(xValue.error, 3000, true);
			return;
		}

		var yValue = parseInput(cameraYInput, "Camera Y");
		if (yValue.error) {
			showMessageBar(yValue.error, 3000, true);
			return;
		}

		var zValue = parseInput(cameraZInput, "Camera Z");
		if (zValue.error) {
			showMessageBar(zValue.error, 3000, true);
			return;
		}

		var outputDir = outputDirInput.value.trim();
		if (!outputDir) {
			showMessageBar("Output folder is required.", 3000, true);
			return;
		}

		var baseName = baseNameInput.value.trim() || "screenshot";

		var rows = focusList.querySelectorAll(".screenshot-focus-row");
		if (!rows.length) {
			showMessageBar("Add at least one focus point.", 3000, true);
			return;
		}

		var focusPoints = [];
		for (var i = 0; i < rows.length; i++) {
			var inputs = rows[i].querySelectorAll("input");
			var fx = parseInput(inputs[0], "Focus X");
			if (fx.error) {
				showMessageBar(fx.error, 3000, true);
				return;
			}
			var fy = parseInput(inputs[1], "Focus Y");
			if (fy.error) {
				showMessageBar(fy.error, 3000, true);
				return;
			}
			var fz = parseInput(inputs[2], "Focus Z");
			if (fz.error) {
				showMessageBar(fz.error, 3000, true);
				return;
			}
			focusPoints.push({x: fx.value, y: fy.value, z: fz.value});
		}

		var cameraPos = {x: xValue.value, y: yValue.value, z: zValue.value};
		captureBtn.disabled = true;
		captureScreenshotSeries(cameraPos, focusPoints, outputDir, baseName, function () {
			captureBtn.disabled = false;
		});
	};
};

function showStatusMessage(message, timeout_ms) {
	pyObj.showStatusMessage(message, timeout_ms || 0);
	console.log(message);
}

function clearStatusMessage() {
	showStatusMessage("");
}

function setPreviewEnabled(enabled) {
	var e = Q3D.E("cover");

	if (enabled) {
		app.resume();
	}
	else {
		app.pause();
		e.innerHTML = '<img src="../../Qgis2threejs.png">';
	}
	e.style.display = (enabled) ? "none" : "block";
}

function setOutlineEffectEnabled(enabled) {
	if (enabled) {
		if (THREE.OutlineEffect === undefined) {
			loadScriptFile("../js/lib/threejs/effects/OutlineEffect.js", function () {
				app.effect = new THREE.OutlineEffect(app.renderer);
			});
		}
		else if (app.effect !== undefined) {
			app.effect = new THREE.OutlineEffect(app.renderer);
		}
	}
	else {
		app.effect = undefined;
	}
}

function setBackgroundColor(color, alpha) {
	app.renderer.setClearColor(color, alpha);
	app.render();
}

function verifySize(width, height) {
	var vec2 = new THREE.Vector2();
	app.renderer.getSize(vec2);
	return (vec2.x == width && vec2.y == height);
}

//// camera
function switchCamera(is_ortho) {
	app.buildCamera(is_ortho);
	app.controls.object = app.camera;
	app.controls.reset();

	console.log("Camera switched to " + ((is_ortho) ? "orthographic" : "perspective") + " camera.");

	// change parent of light
	var p = app.scene.userData;
	if (p.light) {
		app.scene.dispatchEvent({type: "lightChanged", light: p.light});
	}

	// rebuild view helper
	if (app.viewHelper !== undefined) {
		app.buildViewHelper(Q3D.E("navigation"));
	}

	app.updateControlsAndRender();
}

// current camera position and its target
function cameraState(flat) {
	var p = app.scene.toMapCoordinates(app.camera.position),
			t = app.scene.toMapCoordinates(app.controls.target);
	if (flat) {
		return {
			x: p.x, y: p.y, z: p.z, fx: t.x, fy: t.y, fz: t.z
		};
	}

	return {
		pos: {x: p.x, y: p.y, z: p.z},
		lookAt: {x: t.x, y: t.y, z: t.z}
	};
}

function setCameraState(s) {
	if (s.pos !== undefined) {
		app.camera.position.copy(app.scene.toWorldCoordinates(s.pos));
		app.controls.target.copy(app.scene.toWorldCoordinates(s.lookAt));
	}
	else {
		app.camera.position.copy(app.scene.toWorldCoordinates(s));
		app.controls.target.copy(app.scene.toWorldCoordinates({x: s.fx, y: s.fy, z: s.fz}));
	}
	app.camera.lookAt(app.controls.target);
	app.render();
}

function adjustCameraPos() {
	if (Q3D.Config.autoAdjustCameraPos) {
		app.adjustCameraPosition();
	}
	app.render();
}

//// lights
function changeLight(type) {
	app.scene.lightGroup.clear();
	app.scene.buildLights(Q3D.Config.lights[type], app.scene.userData.baseExtent.rotation);
	app.scene.dispatchEvent({type: "lightChanged", light: type});
	app.render();
}

//// widgets
function setNavigationEnabled(enabled) {
	var elm = Q3D.E("navigation");
	elm.style.display = (enabled) ? "block" : "none";

	if (enabled) {
		if (app.viewHelper === undefined) {
			app.buildViewHelper(elm);
			app.viewHelper.render(app.renderer3);
		}
	}
	else {
		app.viewHelper = undefined;
	}
}

function setNorthArrowVisible(visible) {
	Q3D.E("northarrow").style.display = (visible) ? "block" : "none";
	if (visible && app.scene2 === undefined) {
		app.buildNorthArrow(Q3D.E("northarrow"), 0, app.scene.userData.baseExtent.rotation);
		app.render();
	}
}

function setNorthArrowColor(color) {
	if (app.scene2 === undefined) {
		Q3D.Config.northArrow.color = color;
	}
	else {
		app.scene2.children[app.scene2.children.length - 1].material.color = new THREE.Color(color);
		app.render();
	}
}

//// animation
function loadKeyframeGroups(groups) {
	app.animation.keyframes.clear();
	app.animation.keyframes.load(groups);
}

function startAnimation(groups, repeat) {
	if (groups) loadKeyframeGroups(groups);
	Q3D.Config.animation.repeat = Boolean(repeat);

	loadScriptFile("../js/lib/tweenjs/tween.js", function () {
		app.animation.keyframes.start();
	});
}

function stopAnimation() {
	app.animation.keyframes.stop();
	closeNarrativeBox();
}

function showNarrativeBox(content) {
	Q3D.E("narbody").innerHTML = content;
	Q3D.E("narrativebox").classList.add("visible");
	var e = Q3D.E("nextbtn");
	e.className = "";
	e.innerHTML = "Close";
}

function closeNarrativeBox() {
	Q3D.E("narrativebox").classList.remove("visible");
}

function setLayerOpacity(layerId, opacity) {
	app.scene.mapLayers[layerId].opacity = opacity;
}

function saveCanvasImage(width, height) {
	app._saveCanvasImage(width, height, true, function (canvas) {
		pyObj.saveImage(canvas.toDataURL("image/png"));
	});
}

function copyCanvasToClipboard(width, height) {
	app._saveCanvasImage(width, height, true, function (canvas) {
		pyObj.copyToClipboard(canvas.toDataURL("image/png"));
	});
}


//// overrides
app._initLoadingManager = app.initLoadingManager;
app._render = app.render;
app._saveCanvasImage = app.saveCanvasImage;

app.initLoadingManager = function () {
	app._initLoadingManager();

	app.loadingManager.onLoad = function () {
		app.loadingManager.isLoading = false;
		app.dispatchEvent({type: "loadComplete"});	// dispath loadComplete instead of sceneLoaded
	};

	app.loadingManager.onProgress = undefined;
};

app.render = function (immediate) {
	if (!preview.renderEnabled) return;
	if (preview.noRenderDuringLoad && preview.isDataLoading) return;

	app._render(immediate);

	if (immediate) preview.timer.tickCount++;
};

app.saveCanvasImage = function (width, height, fill_background) {
	var saveCanvasImage = function (canvas) {
		pyObj.saveImage(canvas.toDataURL("image/png"));
		gui.popup.hide();
	};
	app._saveCanvasImage(width, height, fill_background, saveCanvasImage);
};

//// polyfills
// for binary glTF export
// https://developer.mozilla.org/ja/docs/Web/API/HTMLCanvasElement/toBlob
if (!HTMLCanvasElement.prototype.toBlob) {
	Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', {
		value: function (callback, type, quality) {
			var binStr = atob(this.toDataURL(type, quality).split(',')[1]),
				len = binStr.length,
				arr = new Uint8Array(len);

			for (var i = 0; i < len; i++) {
				arr[i] = binStr.charCodeAt(i);
			}

			callback(new Blob([arr], {type: type || 'image/png'}));
		}
 	});
}
