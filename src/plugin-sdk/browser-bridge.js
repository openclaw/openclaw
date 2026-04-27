import { loadActivatedBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";
function loadFacadeModule() {
    return loadActivatedBundledPluginPublicSurfaceModuleSync({
        dirName: "browser",
        artifactBasename: "runtime-api.js",
    });
}
export async function startBrowserBridgeServer(params) {
    return await loadFacadeModule().startBrowserBridgeServer(params);
}
export async function stopBrowserBridgeServer(server) {
    await loadFacadeModule().stopBrowserBridgeServer(server);
}
