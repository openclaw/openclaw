import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";
export const DEFAULT_OPENCLAW_BROWSER_ENABLED = true;
export const DEFAULT_BROWSER_EVALUATE_ENABLED = true;
export const DEFAULT_OPENCLAW_BROWSER_COLOR = "#FF4500";
export const DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME = "openclaw";
export const DEFAULT_BROWSER_DEFAULT_PROFILE_NAME = "openclaw";
export const DEFAULT_BROWSER_ACTION_TIMEOUT_MS = 60_000;
export const DEFAULT_AI_SNAPSHOT_MAX_CHARS = 80_000;
export const DEFAULT_UPLOAD_DIR = path.join(resolvePreferredOpenClawTmpDir(), "uploads");
let cachedBrowserProfilesSurface;
function loadBrowserProfilesSurface() {
    cachedBrowserProfilesSurface ??= loadBundledPluginPublicSurfaceModuleSync({
        dirName: "browser",
        artifactBasename: "browser-profiles.js",
    });
    return cachedBrowserProfilesSurface;
}
export function resolveBrowserConfig(cfg, rootConfig) {
    return loadBrowserProfilesSurface().resolveBrowserConfig(cfg, rootConfig);
}
export function resolveProfile(resolved, profileName) {
    return loadBrowserProfilesSurface().resolveProfile(resolved, profileName);
}
