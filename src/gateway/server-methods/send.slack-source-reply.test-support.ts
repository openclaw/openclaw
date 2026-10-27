import { expect, it, type Mock } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type { dispatchChannelMessageAction } from "../../channels/plugins/message-action-dispatch.js";
import type { SessionTranscriptAppendResult } from "../../config/sessions/transcript.js";
import { firstRespondCall } from "./send.test-helpers.js";
import type { MessageMethodDriver, MessageMethodPlugins } from "./send.test-support.js";

type SlackSourceReplyTestHarness = Pick<MessageMethodDriver, "runMessageActionRequest"> &
  Pick<MessageMethodPlugins, "registerMessageActionPlugin"> & {
    mocks: {
      dispatchChannelMessageAction: Mock<typeof dispatchChannelMessageAction>;
      appendAssistantMessageToSessionTranscript: Mock<() => Promise<SessionTranscriptAppendResult>>;
    };
  };

export function registerSendSlackSourceReplyTests({
  mocks,
  runMessageActionRequest,
  registerMessageActionPlugin,
}: SlackSourceReplyTestHarness): void {
  it("mirrors a Slack DM send after target resolution strips its user prefix", async () => {
    registerMessageActionPlugin({
      id: "slack",
      threading: {
        threadAddressing: "message",
        matchesToolContextTarget: ({ target, toolContext }) =>
          target.toLowerCase() ===
          toolContext.currentMessagingTarget?.replace(/^user:/i, "").toLowerCase(),
      },
    });
    mocks.dispatchChannelMessageAction.mockImplementationOnce(async ({ params }) => {
      params.to = "U123";
      return jsonResult({
        ok: true,
        result: {
          messageId: "slack-1",
          receipt: { threadId: "171.222" },
        },
      });
    });

    const { respond } = await runMessageActionRequest({
      params: {
        to: "user:U123",
        message: "visible Slack DM reply",
      },
      sessionKey: "agent:main:slack:direct:U123:thread:171.222",
      agentId: "main",
      toolContext: {
        currentChannelProvider: "slack",
        currentChannelId: "D123",
        currentMessagingTarget: "user:U123",
        currentThreadTs: "171.222",
        replyToMode: "all",
      },
      idempotencyKey: "idem-slack-dm-source-message-action",
    });

    expect(firstRespondCall(respond)[0]).toBe(true);
    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:slack:direct:U123:thread:171.222",
      text: "visible Slack DM reply",
      mediaUrls: undefined,
      idempotencyKey: "idem-slack-dm-source-message-action",
      deliveryMirror: { kind: "message-tool-source-reply" },
      config: {},
    });
  });
}
