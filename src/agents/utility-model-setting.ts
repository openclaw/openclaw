import {
  resolveAgentModelFallbackValues,
  resolveSelectedModelFallbacksOverride,
} from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentConfig } from "./agent-scope-config.js";

type UtilityModelSetting =
  | { kind: "explicit"; modelRef: string; fallbacks: string[] }
  | { kind: "disabled" }
  | { kind: "auto"; fallbacks: string[] };

/** An agent's defined empty value disables utility routing instead of inheriting defaults. */
export function readUtilityModelSetting(
  cfg: OpenClawConfig,
  agentId?: string,
): UtilityModelSetting {
  const agent = agentId ? resolveAgentConfig(cfg, agentId)?.utilityModel : undefined;
  const defaults = cfg.agents?.defaults?.utilityModel;
  const primary = (value: typeof defaults) => (typeof value === "string" ? value : value?.primary);
  const modelRef = (primary(agent) ?? primary(defaults))?.trim();
  if (modelRef === "") {
    return { kind: "disabled" };
  }
  const fallbacks =
    resolveSelectedModelFallbacksOverride(agent) ?? resolveAgentModelFallbackValues(defaults);
  return modelRef ? { kind: "explicit", modelRef, fallbacks } : { kind: "auto", fallbacks };
}
