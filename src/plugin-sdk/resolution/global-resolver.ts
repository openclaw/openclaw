import path from "path";
import fs from "fs";

/**
 * Resolves the plugin-sdk path for global OpenClaw installations.
 * Ensures that third-party plugins in ~/.openclaw/extensions can find the core SDK.
 * Addresses #53946.
 */
export function resolveGlobalPluginSdkRoot() {
    // Attempt to find the package root based on the CLI entry point
    const cliPath = process.argv[1];
    const potentialRoot = path.resolve(cliPath, "..", "..");
    
    if (fs.existsSync(path.join(potentialRoot, "package.json"))) {
        console.info(`[loader] Resolved global OpenClaw root: ${potentialRoot}`);
        return potentialRoot;
    }
    
    // Fallback to standard global node_modules paths if CLI detection fails
    return "/usr/local/lib/node_modules/openclaw";
}
