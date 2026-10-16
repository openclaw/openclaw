import type { HandleCommandsParams } from "./commands-types.js";
import { parseInlineSessionDirectives } from "./directive-handling.parse.js";

export function buildSessionCommandTestParams(
  command: HandleCommandsParams["command"],
  overrides: Partial<Omit<HandleCommandsParams, "command">> = {},
): HandleCommandsParams {
  return {
    ctx: {},
    cfg: {},
    command,
    agentId: "main",
    directives: parseInlineSessionDirectives(""),
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
