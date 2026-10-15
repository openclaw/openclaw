import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { settleReplyDispatcher } from "../dispatch-dispatcher.js";
import { emptyConfig, mocks, transcriptMocks } from "./dispatch-from-config.shared.test-harness.js";
import {
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  setNoAbort,
} from "./dispatch-from-config.test-support.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);
beforeEach(describe0BeforeEach0);

it.each([
  { body: "/think high", gatewayOwned: true },
  { body: "/think high\nPreserve the prompt's whitespace.", gatewayOwned: true },
  { body: "/think high", gatewayOwned: false },
  { body: "/think high\nPreserve the prompt's whitespace.", gatewayOwned: false },
])(
  "preserves WebChat command transcript ownership (Gateway: $gatewayOwned, $body)",
  async ({ body, gatewayOwned }) => {
    setNoAbort();
    const deliver = vi.fn();
    const dispatcher = createReplyDispatcher({ deliver });
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockClear();
    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Body: body,
        BodyForCommands: body,
        Provider: "webchat",
        Surface: "webchat",
        OriginatingChannel: "webchat",
        SessionKey: "agent:main:main",
        From: "agent:main:main",
        To: "agent:main:main",
        MessageSid: "gateway-command-message",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyOptions: gatewayOwned
        ? {
            userTurnTranscriptRecorder: createUserTurnTranscriptRecorder({
              input: { text: body },
              target: () => undefined,
            }),
          }
        : undefined,
      replyResolver: async (_ctx, options) => {
        await options?.onBlockReply?.({ text: "Command progress" });
        return { text: "Command complete" };
      },
    });
    await settleReplyDispatcher({ dispatcher });
    expect(result.queuedFinal).toBe(true);
    expect(deliver.mock.calls.map(([payload]) => payload.text)).toEqual([
      "Command progress",
      "Command complete",
    ]);
    expect(transcriptMocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledTimes(
      gatewayOwned ? 0 : 2,
    );
  },
);

it.each([true, false])(
  "preserves fast-stop WebChat transcript ownership (Gateway: %s)",
  async (gatewayOwned) => {
    mocks.tryFastAbortFromMessage.mockResolvedValue({ handled: true, aborted: true });
    const deliver = vi.fn();
    const dispatcher = createReplyDispatcher({ deliver });
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockClear();
    const replyResolver = vi.fn();
    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Body: "/stop",
        BodyForCommands: "/stop",
        Provider: "webchat",
        Surface: "webchat",
        OriginatingChannel: "webchat",
        SessionKey: "agent:main:main",
        From: "agent:main:main",
        To: "agent:main:main",
        MessageSid: "gateway-stop",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyOptions: gatewayOwned
        ? {
            userTurnTranscriptRecorder: createUserTurnTranscriptRecorder({
              input: { text: "/stop" },
              target: () => undefined,
            }),
          }
        : undefined,
      replyResolver,
    });
    await settleReplyDispatcher({ dispatcher });
    expect(deliver.mock.calls.map(([payload]) => payload.text)).toEqual(["⚙️ Agent was aborted."]);
    expect(replyResolver).not.toHaveBeenCalled();
    expect(transcriptMocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledTimes(
      gatewayOwned ? 0 : 1,
    );
  },
);
