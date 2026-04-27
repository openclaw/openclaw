import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";
let cachedBrowserControlAuthSurface;
function loadBrowserControlAuthSurface() {
    cachedBrowserControlAuthSurface ??=
        loadBundledPluginPublicSurfaceModuleSync({
            dirName: "browser",
            artifactBasename: "browser-control-auth.js",
        });
    return cachedBrowserControlAuthSurface;
}
export function resolveBrowserControlAuth(cfg, env = process.env) {
    return loadBrowserControlAuthSurface().resolveBrowserControlAuth(cfg, env);
}
export function shouldAutoGenerateBrowserAuth(env) {
    return loadBrowserControlAuthSurface().shouldAutoGenerateBrowserAuth(env);
}
export async function ensureBrowserControlAuth(params) {
    return await loadBrowserControlAuthSurface().ensureBrowserControlAuth(params);
}
