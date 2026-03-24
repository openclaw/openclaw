/**
 * Validates WebSocket upgrade origins against trusted proxies and tailscale hosts.
 * Addresses #54008 (Tailscale Serve connectivity).
 */
export function isTrustedProxyOrigin(origin: string, allowedOrigins: string[], isTailscale: boolean): boolean {
    if (isTailscale && origin.includes(".ts.net")) {
        return true;
    }
    
    // Check against wildcard patterns in allowedOrigins
    return allowedOrigins.some(pattern => {
        const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
        return regex.test(origin);
    });
}
