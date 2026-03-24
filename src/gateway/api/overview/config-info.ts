import { getOpenClawHome } from "../../../shared/paths/home-resolver.js";
import path from "node:path";

/**
 * Exposes the active config file path for the Control UI.
 * Addresses #53958.
 */
export function getActiveConfigPath(explicitPath?: string): string {
    if (explicitPath) {
        return path.resolve(explicitPath);
    }
    return path.join(getOpenClawHome(), "openclaw.json");
}

export function getGatewayOverviewMetadata(explicitConfigPath?: string) {
    return {
        version: process.env.npm_package_version || "2026.3.24",
        configPath: getActiveConfigPath(explicitConfigPath),
        homeDir: getOpenClawHome()
    };
}
