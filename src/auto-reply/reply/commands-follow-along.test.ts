// Tests /follow-along recording, skill compile, and weekday automations work orders.
import { describe, expect, it } from "vitest";
import { AUTOMATIONS_TOOL_NAME } from "../../agents/tools/automations-tool-name.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { handleFollowAlongCommand } from "./commands-follow-along.js";
import type { HandleCommandsParams } from "./commands-types.js";

function buildFollowAlongParams(commandBodyNormalized: string): HandleCommandsParams {
  return {
    cfg: {},
    ctx: {
      Provider: INTERNAL_MESSAGE_CHANNEL,
      Surface: INTERNAL_MESSAGE_CHANNEL,
      CommandSource: "text",
      Body: commandBodyNormalized,
      RawBody: commandBodyNormalized,
      CommandBody: commandBodyNormalized,
      BodyForCommands: commandBodyNormalized,
      BodyForAgent: commandBodyNormalized,
      BodyStripped: commandBodyNormalized,
    },
    command: {
      commandBodyNormalized,
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "tester",
      channel: INTERNAL_MESSAGE_CHANNEL,
      channelId: INTERNAL_MESSAGE_CHANNEL,
      surface: INTERNAL_MESSAGE_CHANNEL,
      ownerList: [],
      rawBodyNormalized: commandBodyNormalized,
    },
    directives: {},
    elevated: { enabled: true, allowed: true, failures: [] },
    agentId: "researcher",
    sessionKey: "agent:researcher:webchat:test",
    workspaceDir: "/tmp",
    provider: "openai",
    model: "gpt-5.6",
    contextTokens: 0,
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    isGroup: false,
  } as unknown as HandleCommandsParams;
}

function rewrittenBody(params: HandleCommandsParams): string {
  return (params.ctx as { BodyForAgent?: string }).BodyForAgent ?? "";
}

describe("follow-along command", () => {
  it("ignores unrelated text", async () => {
    expect(await handleFollowAlongCommand(buildFollowAlongParams("check ci"), true)).toBeNull();
  });

  it("starts a recording on the persistent computer", async () => {
    const result = await handleFollowAlongCommand(
      buildFollowAlongParams("/follow-along start"),
      true,
    );
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Follow-along recording started");
  });

  it("rewrites schedule into a current-session automations work order", async () => {
    const params = buildFollowAlongParams("/follow-along schedule weekday");
    const result = await handleFollowAlongCommand(params, true);
    expect(result).toMatchObject({ shouldContinue: true });
    expect(rewrittenBody(params)).toContain(AUTOMATIONS_TOOL_NAME);
    expect(rewrittenBody(params)).toContain('sessionTarget:"current"');
    expect(rewrittenBody(params)).toContain('schedule:{kind:"cron"');
    expect(rewrittenBody(params)).toContain("researcher");
    expect(rewrittenBody(params)).toContain("not an orphan cron");
  });
});
