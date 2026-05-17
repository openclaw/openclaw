import { describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import { createHookRunnerWithRegistry } from "./hooks.test-helpers.js";

const replyPayloadSendingEvent = {
  payload: { text: "hello" } satisfies ReplyPayload,
  kind: "final" as const,
  channel: "telegram",
  sessionKey: "agent:test:session",
  runId: "run-123",
};

const replyPayloadSendingCtx = {
  channelId: "telegram",
  accountId: "default",
  conversationId: "conv-1",
  sessionKey: "agent:test:session",
  runId: "run-123",
};

function firstErrorLog(logger: { error: ReturnType<typeof vi.fn> }) {
  return logger.error.mock.calls[0];
}

describe("reply_payload_sending hook runner", () => {
  it("passes the latest payload between handlers", async () => {
    const first = vi.fn().mockResolvedValue({
      payload: {
        text: "hello",
        presentation: {
          blocks: [{ type: "buttons", buttons: [{ label: "Proceed", value: "action:proceed" }] }],
        },
      } satisfies ReplyPayload,
    });
    const second = vi.fn().mockImplementation(async (event: { payload: ReplyPayload }) => ({
      payload: {
        ...event.payload,
        text: `${event.payload.text ?? ""}!`,
      },
    }));
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "reply_payload_sending", handler: first },
      { hookName: "reply_payload_sending", handler: second },
    ]);

    const result = await runner.runReplyPayloadSending(
      replyPayloadSendingEvent,
      replyPayloadSendingCtx,
    );

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith(
      {
        ...replyPayloadSendingEvent,
        payload: {
          text: "hello",
          presentation: {
            blocks: [{ type: "buttons", buttons: [{ label: "Proceed", value: "action:proceed" }] }],
          },
        },
      },
      replyPayloadSendingCtx,
    );
    expect(result).toEqual({
      payload: {
        text: "hello!",
        presentation: {
          blocks: [{ type: "buttons", buttons: [{ label: "Proceed", value: "action:proceed" }] }],
        },
      },
      cancel: undefined,
      reason: undefined,
    });
  });

  it("stops at the first handler that cancels delivery", async () => {
    const first = vi.fn().mockResolvedValue({ cancel: true, reason: "blocked" });
    const second = vi.fn();
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "reply_payload_sending", handler: first },
      { hookName: "reply_payload_sending", handler: second },
    ]);

    const result = await runner.runReplyPayloadSending(
      replyPayloadSendingEvent,
      replyPayloadSendingCtx,
    );

    expect(result).toEqual({
      payload: { text: "hello" },
      cancel: true,
      reason: "blocked",
    });
    expect(second).not.toHaveBeenCalled();
  });

  it("continues after handler errors", async () => {
    const logger = {
      warn: vi.fn(),
      error: vi.fn(),
    };
    const failing = vi.fn().mockRejectedValue(new Error("boom"));
    const succeeding = vi
      .fn()
      .mockResolvedValue({ payload: { text: "ok" } satisfies ReplyPayload });
    const { runner } = createHookRunnerWithRegistry(
      [
        { hookName: "reply_payload_sending", handler: failing },
        { hookName: "reply_payload_sending", handler: succeeding },
      ],
      { logger },
    );

    const result = await runner.runReplyPayloadSending(
      replyPayloadSendingEvent,
      replyPayloadSendingCtx,
    );

    expect(result).toEqual({ payload: { text: "ok" }, cancel: undefined, reason: undefined });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(firstErrorLog(logger)).toEqual([
      "[hooks] reply_payload_sending handler from test-plugin failed: boom",
    ]);
  });
});
