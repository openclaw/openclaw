import { buildSessionCommandTestParams } from "./commands-session-params.test-support.js";
import type { CommandContext, HandleCommandsParams } from "./commands-types.js";

export function commandFixture(
  body: string,
  overrides: Partial<HandleCommandsParams> = {},
  command: Partial<CommandContext> = {},
): HandleCommandsParams {
  const { command: commandOverrides, ...params } = overrides;
  return buildSessionCommandTestParams(
    {
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
      ...commandOverrides,
    },
    {
      agentId: "target",
      sessionKey: "agent:target:session",
      workspaceDir: "/tmp/workspace",
      sessionEntry: { sessionId: "session-1", updatedAt: 1 },
      ...params,
    },
  );
}
