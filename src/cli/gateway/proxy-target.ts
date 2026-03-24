import { OpenClawConfig } from "../../config/config.js";

/**
 * Resolves the gateway URL for the CLI client.
 * Prioritizes the --url flag and config-defined remote URL over the default port.
 * Addresses #53945.
 */
export function resolveGatewayTarget(config: OpenClawConfig, explicitUrl?: string): string {
    if (explicitUrl) {
        console.info(`[cli] Targeting explicit gateway: ${explicitUrl}`);
        return explicitUrl;
    }
    
    const remoteUrl = config.gateway?.remote?.url;
    if (remoteUrl) {
        return remoteUrl;
    }

    return "ws://127.0.0.1:18789"; // Default fallback
}
