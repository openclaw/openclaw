import { execAsync } from "../../shared/exec.js";
import fs from "fs";
import path from "path";

/**
 * Self-healing bootstrap janitor.
 * Scans for common runtime failures (missing dependencies, broken builds)
 * and attempts automated remediation before the gateway crashes.
 */
export async function runSelfHealingCheck() {
    console.info("[janitor] Initiating self-healing pre-flight check...");
    
    // Check 1: Plugin Integrity (PR #53818)
    const pluginDir = path.resolve(process.cwd(), "extensions");
    if (fs.existsSync(pluginDir)) {
        const plugins = fs.readdirSync(pluginDir);
        for (const plugin of plugins) {
            const fullPath = path.join(pluginDir, plugin);
            if (fs.statSync(fullPath).isDirectory() && !fs.existsSync(path.join(fullPath, "dist"))) {
                console.warn(`[janitor] ${plugin} build missing. Attempting auto-remediation...`);
                try {
                    await execAsync("npm install && npm run build", { cwd: fullPath });
                    console.info(`[janitor] ${plugin} repaired successfully.`);
                } catch (e) {
                    console.error(`[janitor] Failed to repair ${plugin}.`);
                }
            }
        }
    }
}
