import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { settleReplyDispatcher } from "../dispatch-dispatcher.js";
import { markCommandReplyForDelivery } from "../reply-payload.js";
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

describe("dispatchReplyFromConfig command exchanges", () => {
  beforeEach(describe0BeforeEach0);

  it.each([
    ["telegram", "command-account", "command-chat"],
    ["telegram", "other-account", "command-chat"],
    ["telegram", "command-account", "other-chat"],
    ["discord", "command-account", "command-chat"],
    ["slack", "command-account", "command-chat"],
  ] as const)(
    "records a delivered %s command exchange for account %s and conversation %s",
    async (channel, accountId, conversationId) => {
      setNoAbort();
      const dispatcher = createReplyDispatcher({ deliver: vi.fn() });
      dispatcher.appendBeforeDeliver?.((payload) => ({
        ...payload,
        text: "Thinking level set to low.",
      }));
      transcriptMocks.appendAssistantMessageToSessionTranscript.mockClear();
      await dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Body: "/think low",
          BodyForCommands: "/think low",
          Provider: channel,
          Surface: channel,
          OriginatingChannel: channel,
          SessionKey: "agent:main:main",
          MessageSid: "command-message",
          AccountId: accountId,
          OriginatingTo: conversationId,
          From: conversationId,
          To: conversationId,
        }),
        cfg: emptyConfig,
        dispatcher,
        // get-reply marks command-owner replies; dispatch records only those exchanges.
        replyResolver: async () =>
          markCommandReplyForDelivery({ text: "Before delivery transform" }),
      });
      await settleReplyDispatcher({ dispatcher });
      expect(transcriptMocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Thinking level set to low.",
          command: {
            text: "/think low",
            idempotencyKey: `command-input:["${channel}","${accountId}","${conversationId}","command-message"]`,
          },
        }),
      );
    },
  );

  it("does not record an agent turn that starts with an inline directive as a command exchange", async () => {
    setNoAbort();
    const dispatcher = createReplyDispatcher({ deliver: vi.fn() });
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockClear();
    const text = "/think high\nSummarize the report.";
    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Body: text,
        BodyForCommands: text,
        Provider: "webchat",
        Surface: "webchat",
        OriginatingChannel: "webchat",
        SessionKey: "agent:main:main",
        MessageSid: "directive-turn",
      }),
      cfg: emptyConfig,
      dispatcher,
      // The inline directive ack streams as a status block; the agent owns the answer row.
      replyResolver: async (_ctx, opts) => {
        await opts?.onBlockReply?.({ text: "Thinking level set to high.", isStatusNotice: true });
        return { text: "Here is the summary." };
      },
    });
    await settleReplyDispatcher({ dispatcher });
    expect(transcriptMocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.anything() }),
    );
  });

  it("records the stop command next to the delivered fast-abort notice", async () => {
    mocks.tryFastAbortFromMessage.mockResolvedValue({ handled: true, aborted: true });
    const dispatcher = createReplyDispatcher({ deliver: vi.fn() });
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockClear();
    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Body: "/stop",
        BodyForCommands: "/stop",
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        SessionKey: "agent:main:main",
        MessageSid: "stop-message",
        AccountId: "stop-account",
        OriginatingTo: "stop-chat",
        From: "stop-chat",
        To: "stop-chat",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: vi.fn(),
    });
    await settleReplyDispatcher({ dispatcher });
    expect(transcriptMocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "⚙️ Agent was aborted.",
        command: {
          text: "/stop",
          idempotencyKey: 'command-input:["telegram","stop-account","stop-chat","stop-message"]',
        },
      }),
    );
  });
});
