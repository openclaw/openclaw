import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentConfig } from "./agent-scope-config.js";

type UtilityModelSetting =
  | { kind: "explicit"; modelRef: string }
  | { kind: "disabled" }
  | { kind: "auto" };

/** An agent's defined empty value disables utility routing instead of inheriting defaults. */
export function readUtilityModelSetting(
  cfg: OpenClawConfig,
  agentId?: string,
): UtilityModelSetting {
  const value =
    (agentId ? resolveAgentConfig(cfg, agentId)?.utilityModel : undefined) ??
    cfg.agents?.defaults?.utilityModel;
  if (value === undefined) {
    return { kind: "auto" };
  }
  const trimmed = value.trim();
  return trimmed ? { kind: "explicit", modelRef: trimmed } : { kind: "disabled" };
}
