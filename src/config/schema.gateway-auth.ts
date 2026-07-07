export const GATEWAY_AUTH_FIELD_HELP: Record<string, string> = {
  "gateway.auth":
    "Authentication policy for gateway HTTP/WebSocket access including mode, credentials, trusted-proxy behavior, and rate limiting. Keep auth enabled for every non-loopback deployment.",
  "gateway.auth.mode":
    'Gateway auth mode: "none", "token", "password", or "trusted-proxy" depending on your edge architecture. Use token/password for direct exposure, and trusted-proxy only behind hardened identity-aware proxies.',
  "gateway.auth.allowTailscale":
    "Allows trusted Tailscale identity paths to satisfy gateway auth checks when configured. Use this only when your tailnet identity posture is strong and operator workflows depend on it.",
  "gateway.auth.requireTailscaleSharedSecret":
    "Requires Tailscale Serve Control UI/WebSocket requests to pass both verified Tailscale identity and the configured token/password. Enable when tailnet membership is not enough by itself.",
  "gateway.auth.rateLimit":
    "Login/auth attempt throttling controls to reduce credential brute-force risk at the gateway boundary. Keep enabled in exposed environments and tune thresholds to your traffic baseline.",
  "gateway.auth.trustedProxy":
    "Trusted-proxy auth header mapping for upstream identity providers that inject user claims. Use only with known proxy CIDRs and strict header allowlists to prevent spoofed identity headers.",
};

export const GATEWAY_AUTH_FIELD_LABELS: Record<string, string> = {
  "gateway.auth": "Gateway Auth",
  "gateway.auth.mode": "Gateway Auth Mode",
  "gateway.auth.allowTailscale": "Gateway Auth Allow Tailscale Identity",
  "gateway.auth.requireTailscaleSharedSecret": "Gateway Auth Require Tailscale Shared Secret",
  "gateway.auth.rateLimit": "Gateway Auth Rate Limit",
  "gateway.auth.trustedProxy": "Gateway Trusted Proxy Auth",
};
