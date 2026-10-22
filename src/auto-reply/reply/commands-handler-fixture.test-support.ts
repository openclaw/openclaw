import type { CommandContext, HandleCommandsParams } from "./commands-types.js";
import { parseInlineSessionDirectives } from "./directive-handling.parse.js";

export function commandFixture(
  body: string,
  overrides: Partial<HandleCommandsParams> = {},
  command: Partial<CommandContext> = {},
): HandleCommandsParams {
  return {
    cfg: {},
    ctx: {},
    agentId: "target",
    sessionKey: "agent:target:session",
    workspaceDir: "/tmp/workspace",
    sessionEntry: { sessionId: "session-1", updatedAt: 1 },
    directives: parseInlineSessionDirectives(""),
    elevated: { enabled: true, allowed: true, failures: [] },
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "openai",
    model: "gpt-5.4",
    contextTokens: 0,
    isGroup: false,
    ...overrides,
    command: {
      commandBodyNormalized: body,
      rawBodyNormalized: body,
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "sender-1",
      channel: "quietchat",
      surface: "quietchat",
      ownerList: [],
      from: "sender-1",
      to: "bot",
      ...command,
      ...overrides.command,
    },
  };
}
