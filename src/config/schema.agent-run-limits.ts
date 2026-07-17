export const AGENT_RUN_LIMIT_FIELD_HELP: Record<string, string> = {
  "agents.defaults.runRetries":
    "Outer run loop retry iteration boundaries for the embedded OpenClaw runner to prevent infinite execution loops during failure recovery.",
  "agents.defaults.runRetries.base":
    "Base number of run retry iterations for the embedded OpenClaw runner's outer run loop (default: 24).",
  "agents.defaults.runRetries.perProfile":
    "Additional run retry iterations granted per fallback profile candidate (default: 8).",
  "agents.defaults.runRetries.min":
    "Minimum absolute limit for run retry iterations (default: 32).",
  "agents.defaults.runRetries.max":
    "Maximum absolute limit for run retry iterations to prevent runaway execution (default: 160).",
  "agents.list[].runRetries":
    "Optional per-agent override for the embedded OpenClaw runner's outer run loop retry iteration boundaries.",
  "agents.list[].runRetries.base": "Base number of run retry iterations for this agent.",
  "agents.list[].runRetries.perProfile":
    "Additional run retry iterations granted per fallback profile candidate for this agent.",
  "agents.list[].runRetries.min": "Minimum absolute limit for run retry iterations for this agent.",
  "agents.list[].runRetries.max": "Maximum absolute limit for run retry iterations for this agent.",
  "agents.defaults.maxToolCallingRounds":
    "Maximum LLM tool-calling rounds allowed in one agent run. Unset means no hard limit.",
  "agents.defaults.subagents.maxToolCallingRounds":
    "Maximum LLM tool-calling rounds allowed in one spawned sub-agent run. Falls back to agents.defaults.maxToolCallingRounds when unset.",
  "agents.list[].maxToolCallingRounds":
    "Maximum LLM tool-calling rounds for this agent. Overrides both ordinary and sub-agent defaults.",
};

export const AGENT_RUN_LIMIT_FIELD_LABELS: Record<string, string> = {
  "agents.defaults.runRetries": "Run Retries",
  "agents.defaults.runRetries.base": "Run Retries Base",
  "agents.defaults.runRetries.perProfile": "Run Retries Per Profile",
  "agents.defaults.runRetries.min": "Run Retries Minimum",
  "agents.defaults.runRetries.max": "Run Retries Maximum",
  "agents.list[].runRetries": "Agent Run Retries",
  "agents.list[].runRetries.base": "Agent Run Retries Base",
  "agents.list[].runRetries.perProfile": "Agent Run Retries Per Profile",
  "agents.list[].runRetries.min": "Agent Run Retries Minimum",
  "agents.list[].runRetries.max": "Agent Run Retries Maximum",
  "agents.defaults.maxToolCallingRounds": "Maximum Tool-Calling Rounds",
  "agents.defaults.subagents.maxToolCallingRounds": "Sub-Agent Maximum Tool-Calling Rounds",
  "agents.list[].maxToolCallingRounds": "Agent Maximum Tool-Calling Rounds",
};
