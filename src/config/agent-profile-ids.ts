const AGENT_PROFILE_IDS = ["openclaw/base", "openclaw/small"] as const;

export const AGENT_PROFILE_SELECTORS = ["auto", ...AGENT_PROFILE_IDS] as const;

export type AgentProfileId = (typeof AGENT_PROFILE_IDS)[number];
export type AgentProfileSelector = (typeof AGENT_PROFILE_SELECTORS)[number];

export function isAgentProfileSelector(value: unknown): value is AgentProfileSelector {
  return AGENT_PROFILE_SELECTORS.some((selector) => selector === value);
}
