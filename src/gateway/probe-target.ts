import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Describes whether probe commands should contact the local gateway or a configured remote. */
export type GatewayProbeTargetResolution = {
  /** Configured gateway mode before remote URL validation. */
  gatewayMode: "local" | "remote";
  /** Effective probe target after falling back from incomplete remote config. */
  mode: "local" | "remote";
  /** True when remote mode is configured but no usable remote URL is available. */
  remoteUrlMissing: boolean;
};

/** Resolves the effective gateway probe target without letting partial remote config fail closed. */
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
