/** Built-in Agent Profile ids; `auto` defers to the next selection scope. */
const AGENT_PROFILE_IDS = ["openclaw/base", "openclaw/lean", "openclaw/small"] as const;
export type AgentProfileId = (typeof AGENT_PROFILE_IDS)[number];
export const AGENT_PROFILE_SELECTORS = ["auto", ...AGENT_PROFILE_IDS] as const;
/** Scope that selected a run's Agent Profile. */
export type AgentProfileSelectionSource =
  | "agent-explicit"
  | "defaults-explicit"
  | "agent-model"
  | "defaults-model"
  | "fallback";
