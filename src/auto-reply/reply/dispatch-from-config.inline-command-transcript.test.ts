import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { settleReplyDispatcher } from "../dispatch-dispatcher.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import { emptyConfig, transcriptMocks } from "./dispatch-from-config.shared.test-harness.js";
import {
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  requireBlockReplyHandler,
  setNoAbort,
} from "./dispatch-from-config.test-support.js";
import {
  createTypingController,
  mockCallArgs,
  runTestInlineActions,
  type HandleInlineActionsInput,
} from "./get-reply-inline-actions.test-support.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);
beforeEach(describe0BeforeEach0);

it("delivers a continuing mixed directive ack as a status block without losing metadata", async () => {
  const typing = createTypingController();
  const ctx = buildTestCtx({ Body: "keep going", CommandBody: "keep going" });
  const onBlockReply = vi.fn(async () => {});
  const directiveAck = setReplyPayloadMetadata(
    { text: "Model set to openai/gpt-5.5 for this session." },
    { assistantMessageIndex: 7 },
  );
  const result = await runTestInlineActions({
    ctx,
    typing,
    cleanedBody: "keep going",
    overrides: {
      directiveAck,
      opts: { onBlockReply } as HandleInlineActionsInput["opts"],
    },
  });
  expect(result.kind).toBe("continue");
  expect(onBlockReply).toHaveBeenCalledTimes(1);
  const delivered = mockCallArgs(onBlockReply, "onBlockReply")[0];
  expect(delivered).toEqual({
    text: "Model set to openai/gpt-5.5 for this session.",
    isStatusNotice: true,
  });
  expect(getReplyPayloadMetadata(delivered as object)).toEqual({
    assistantMessageIndex: 7,
    deliverDespiteSourceReplySuppression: true,
    inlineCommandReply: true,
  });
});

it.each(["block", "final"] as const)(
  "does not mirror an inline directive %s acknowledgement as a second user turn",
  async (kind) => {
    setNoAbort();
    const deliver = vi.fn();
    const dispatcher = createReplyDispatcher({ deliver });
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockClear();
    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Body: "/think high\nExplain this code.",
        BodyForCommands: "/think high\nExplain this code.",
        Provider: "webchat",
        Surface: "webchat",
        SessionKey: "agent:main:main",
        MessageSid: "inline-directive-message",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async (_ctx, opts) => {
        const ack = setReplyPayloadMetadata(
          { text: "Thinking level set to high." },
          { inlineCommandReply: true },
        );
        if (kind === "block") {
          await requireBlockReplyHandler(opts?.onBlockReply)(ack);
          return undefined;
        }
        return ack;
      },
    });
    await settleReplyDispatcher({ dispatcher });
    expect(deliver).toHaveBeenCalled();
    expect(transcriptMocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
  },
);
