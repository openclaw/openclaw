import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { HookClientIpConfig } from "./hooks-request-handler.js";

/** Project Gateway trust settings into the narrow hook-auth throttling policy. */
export function resolveHookClientIpConfig(cfg: OpenClawConfig): HookClientIpConfig {
  return {
    trustedProxies: cfg.gateway?.trustedProxies,
    allowRealIpFallback: cfg.gateway?.allowRealIpFallback === true,
  };
}
