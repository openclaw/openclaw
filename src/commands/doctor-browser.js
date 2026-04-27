import { loadBundledPluginPublicSurfaceModuleSync } from "../plugin-sdk/facade-loader.js";
import { note } from "../terminal/note.js";
function loadBrowserDoctorSurface() {
    return loadBundledPluginPublicSurfaceModuleSync({
        dirName: "browser",
        artifactBasename: "browser-doctor.js",
    });
}
export async function noteChromeMcpBrowserReadiness(cfg, deps) {
    try {
        await loadBrowserDoctorSurface().noteChromeMcpBrowserReadiness(cfg, deps);
    }
    catch (error) {
        const noteFn = deps?.noteFn ?? note;
        const message = error instanceof Error ? error.message : String(error);
        noteFn(`- Browser health check is unavailable: ${message}`, "Browser");
    }
}
