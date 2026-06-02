import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export type GatewayProbeTargetResolution = {
  gatewayMode: "local" | "remote";
  mode: "local" | "remote";
  remoteUrlMissing: boolean;
};

/**
 * Resolve whether status/probe commands should target the local gateway or a
 * configured remote gateway. Remote mode falls back to local when the remote URL
 * is missing so diagnostics can report the config gap without making a bad HTTP
 * request.
 */
export function resolveGatewayProbeTarget(cfg: OpenClawConfig): GatewayProbeTargetResolution {
  const gatewayMode = cfg.gateway?.mode === "remote" ? "remote" : "local";
  const remoteUrlRaw = normalizeOptionalString(cfg.gateway?.remote?.url) ?? "";
  const remoteUrlMissing = gatewayMode === "remote" && !remoteUrlRaw;
  return {
    gatewayMode,
    mode: gatewayMode === "remote" && !remoteUrlMissing ? "remote" : "local",
    remoteUrlMissing,
  };
}
