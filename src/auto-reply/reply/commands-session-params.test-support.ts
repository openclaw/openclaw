import type { HandleCommandsParams } from "./commands-types.js";

export function buildSessionCommandTestParams(
  command: HandleCommandsParams["command"],
  overrides: Partial<Omit<HandleCommandsParams, "command">> = {},
): HandleCommandsParams {
  return {
    ctx: {},
    cfg: {},
    command,
    agentId: "main",
    directives: {},
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey: "agent:main:main",
    workspaceDir: "/tmp",
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "openai",
    model: "gpt-5.4",
    contextTokens: 0,
    isGroup: false,
    ...overrides,
  };
}
