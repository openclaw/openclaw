import fs from "fs";
import path from "path";
import { execAsync } from "../../shared/exec.js";

export async function ensurePluginIntegrity(pluginDir: string, pluginName: string) {
    const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
    if (!fs.existsSync(manifestPath)) return;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    const required = manifest.runtimeFiles || ["dist", "package.json"];
    const missing = required.filter((f: string) => !fs.existsSync(path.join(pluginDir, f)));
    if (missing.length > 0) {
        console.warn(`[self-healing] ${pluginName} is missing ${missing.length} runtime files. Repairing...`);
        try {
            await execAsync("npm install --prefer-offline", { cwd: pluginDir });
        } catch (e) {}
    }
}
