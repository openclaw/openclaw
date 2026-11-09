import type { GatewayReloadMode } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export function resolveGatewayReloadSettings(
  cfg: OpenClawConfig,
  debounceMs = 300,
): { mode: GatewayReloadMode; debounceMs: number } {
  return { mode: cfg.gateway?.reload?.mode === "off" ? "off" : "hybrid", debounceMs };
}
