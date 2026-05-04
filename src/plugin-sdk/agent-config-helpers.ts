import { resolveAgentConfig } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/**
 * Resolve the normalized reasoningDefault for an agent, applying per-agent config first then
 * falling back to global agents.defaults.reasoningDefault, then "off".
 */
export function resolveConfigReasoningDefault(
  cfg: OpenClawConfig,
  agentId: string,
): "on" | "stream" | "verbose" | "off" {
  const agentDefault = resolveAgentConfig(cfg, agentId)?.reasoningDefault;
  const globalDefault = cfg.agents?.defaults?.reasoningDefault;
  const raw = agentDefault ?? globalDefault;
  return raw === "on" || raw === "stream" || raw === "verbose" || raw === "off" ? raw : "off";
}
