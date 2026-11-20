const AGENT_PROFILE_IDS = ["openclaw/base", "openclaw/small"] as const;

export const AGENT_PROFILE_SELECTORS = AGENT_PROFILE_IDS;

export type AgentProfileId = (typeof AGENT_PROFILE_IDS)[number];
export type AgentProfileSelector = (typeof AGENT_PROFILE_SELECTORS)[number];

export function isAgentProfileSelector(value: unknown): value is AgentProfileSelector {
  return AGENT_PROFILE_SELECTORS.some((selector) => selector === value);
}
