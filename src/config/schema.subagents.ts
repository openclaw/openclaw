export const SUBAGENT_FIELD_HELP: Record<string, string> = {
  "agents.defaults.subagents.delegationMode":
    'Prompt-only sub-agent delegation strength. "suggest" keeps the default guidance; "prefer" strongly instructs the main agent to delegate anything more involved than a direct reply via sessions_spawn.',
  "agents.defaults.subagents.announceTarget":
    'Default native sub-agent completion routing. "channel" preserves direct completion announces; "parent" wakes the requester session with no direct channel announce.',
  "agents.list[].subagents.delegationMode":
    "Per-agent override for sub-agent delegation strength. Use this for coordinator agents that should stay responsive and push non-trivial work into spawned sub-agents.",
  "agents.list[].subagents.announceTarget":
    'Per-agent native sub-agent completion routing. "parent" is useful for coordinator agents that should synthesize child results before replying.',
};

export const SUBAGENT_FIELD_LABELS: Record<string, string> = {
  "agents.defaults.subagents.delegationMode": "Sub-agent Delegation Mode",
  "agents.defaults.subagents.announceTarget": "Sub-agent Announce Target",
  "agents.list[].subagents.delegationMode": "Sub-agent Delegation Mode",
  "agents.list[].subagents.announceTarget": "Sub-agent Announce Target",
};
