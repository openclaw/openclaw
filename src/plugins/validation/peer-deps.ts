import fs from "node:fs";
import path from "node:path";

/**
 * Validates plugin peer dependencies against the gateway runtime.
 * Alerts if a plugin requires a version incompatible with the core SDK.
 */
export function validatePluginPeerDeps(pluginDir: string, coreVersion: string) {
    const pkgPath = path.join(pluginDir, "package.json");
    if (!fs.existsSync(pkgPath)) return;

    try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        const peerClaw = pkg.peerDependencies?.openclaw;
        
        if (peerClaw && !coreVersion.includes(peerClaw.replace(/^[^0-9]+/, ""))) {
            console.warn(`[plugins] Warning: Plugin in ${pluginDir} expects openclaw ${peerClaw}, but current version is ${coreVersion}.`);
            return false;
        }
    } catch (e) {
        // Parse error or missing field
    }
    return true;
}
