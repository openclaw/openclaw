import {
  resolveAgentModelFallbackValues,
  resolveSelectedModelFallbacksOverride,
} from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentEntry } from "./agent-scope-config.js";

type UtilityModelSetting =
  | { kind: "explicit"; modelRef: string; fallbacks: string[] }
  | { kind: "disabled" }
  | { kind: "auto"; fallbacks: string[] };

/** An agent's defined empty value disables utility routing instead of inheriting defaults. */
export function readUtilityModelSetting(
  cfg: OpenClawConfig,
  agentId?: string,
): UtilityModelSetting {
  // Only the entry's own field is read; the implicit legacy agent has none.
  const agent = agentId ? resolveAgentEntry(cfg, agentId)?.utilityModel : undefined;
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
