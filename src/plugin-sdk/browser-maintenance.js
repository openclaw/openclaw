import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";
let cachedBrowserMaintenanceSurface;
let secureRandomRuntimePromise;
let execRuntimePromise;
function hasRequestedSessionKeys(sessionKeys) {
    return sessionKeys.some((key) => Boolean(key?.trim()));
}
function loadBrowserMaintenanceSurface() {
    cachedBrowserMaintenanceSurface ??=
        loadBundledPluginPublicSurfaceModuleSync({
            dirName: "browser",
            artifactBasename: "browser-maintenance.js",
        });
    return cachedBrowserMaintenanceSurface;
}
function loadSecureRandomRuntime() {
    secureRandomRuntimePromise ??= import("../infra/secure-random.js");
    return secureRandomRuntimePromise;
}
function loadExecRuntime() {
    execRuntimePromise ??= import("../process/exec.js");
    return execRuntimePromise;
}
export async function closeTrackedBrowserTabsForSessions(params) {
    if (!hasRequestedSessionKeys(params.sessionKeys)) {
        return 0;
    }
    let surface;
    try {
        surface = loadBrowserMaintenanceSurface();
    }
    catch (error) {
        params.onWarn?.(`browser cleanup unavailable: ${String(error)}`);
        return 0;
    }
    return await surface.closeTrackedBrowserTabsForSessions(params);
}
export async function movePathToTrash(targetPath) {
    const [{ generateSecureToken }, { runExec }] = await Promise.all([
        loadSecureRandomRuntime(),
        loadExecRuntime(),
    ]);
    try {
        await runExec("trash", [targetPath], { timeoutMs: 10_000 });
        return targetPath;
    }
    catch {
        const trashDir = path.join(os.homedir(), ".Trash");
        fs.mkdirSync(trashDir, { recursive: true });
        const base = path.basename(targetPath);
        let dest = path.join(trashDir, `${base}-${Date.now()}`);
        if (fs.existsSync(dest)) {
            dest = path.join(trashDir, `${base}-${Date.now()}-${generateSecureToken(6)}`);
        }
        fs.renameSync(targetPath, dest);
        return dest;
    }
}
