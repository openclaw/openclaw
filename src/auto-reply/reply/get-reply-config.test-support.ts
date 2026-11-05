import type { OpenClawConfig } from "../../config/types.openclaw.js";

export function createReplyAgentDefaults(workspace: string) {
  return {
    workspace,
    skipBootstrap: true,
    model: { primary: "mock-openai/gpt-5.6-luna" },
    models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" as const } } },
  };
}

export function withVerboseDefault(config: OpenClawConfig) {
  return { ...config, agents: { defaults: { verboseDefault: "on" as const } } };
}
