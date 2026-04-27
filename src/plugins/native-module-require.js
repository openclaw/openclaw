import { createRequire } from "node:module";
import path from "node:path";
const nodeRequire = createRequire(import.meta.url);
export function isJavaScriptModulePath(modulePath) {
    return [".js", ".mjs", ".cjs"].includes(path.extname(modulePath).toLowerCase());
}
export function tryNativeRequireJavaScriptModule(modulePath, options = {}) {
    if (process.platform === "win32" && options.allowWindows !== true) {
        return { ok: false };
    }
    if (!isJavaScriptModulePath(modulePath)) {
        return { ok: false };
    }
    try {
        return { ok: true, moduleExport: nodeRequire(modulePath) };
    }
    catch {
        return { ok: false };
    }
}
