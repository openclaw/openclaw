import { resolveGatewayPublicOrigin } from "../config/gateway-public-origin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ResolvedGatewayAuth } from "./auth-resolve.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";
import {
  getNextTailscaleServeSignal,
  getTailscalePublishedOrigin,
} from "./tailscale-published-origin.js";

/**
 * Advertise browser identity at the ingress that actually authenticates people.
 * `signal` aborts when this answer goes stale: its Serve route is withdrawn or
 * replaced, or a Serve route appears after an answer given without one.
 */
export function resolveControlUiIdentity(
  cfg: OpenClawConfig,
  auth: ResolvedGatewayAuth,
): { url?: string; signal?: AbortSignal } | undefined {
  if (cfg.gateway?.controlUi?.enabled === false) {
    return undefined;
  }
  let origin: string | undefined;
  let signal: AbortSignal | undefined;
  if (auth.mode === "trusted-proxy") {
    origin = resolveGatewayPublicOrigin(cfg);
  } else if (auth.mode !== "none" && auth.allowTailscale) {
    // Configured publicOrigin may use an unrelated proxy. Only the live Serve
    // claim establishes the dedicated listener that verifies Tailscale identity.
    const published = getTailscalePublishedOrigin();
    if (published?.mode === "serve") {
      origin = published.origin;
      signal = published.signal;
    } else if (!published) {
      // Managed Serve may still be starting or recovering its route.
      return { signal: getNextTailscaleServeSignal() };
    }
  }
  if (!origin?.startsWith("https://")) {
    return undefined;
  }
  return {
    url: `${origin}${normalizeControlUiBasePath(cfg.gateway?.controlUi?.basePath)}/`,
    signal,
  };
}
