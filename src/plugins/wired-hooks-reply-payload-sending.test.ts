import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../auto-reply/reply-payload.js";
import type { PluginHookReplyPayload } from "./hook-types.js";
import { createHookRunnerWithRegistry } from "./hooks.test-fixtures.js";

const messageCtx = { channelId: "demo-channel" };
const messageEvent = { to: "user-123", content: "original content" };
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const replyPayloadSendingEvent = {
  payload: { text: "hello" } satisfies ReplyPayload,
  kind: "final" as const,
  channel: "telegram",
  sessionKey: "agent:test:session",
  runId: "run-123",
};

const replyPayloadSendingCtx = { channelId: "telegram" };

function createRunner(
  handlers: Parameters<typeof createHookRunnerWithRegistry>[0][number]["handler"][],
) {
  return createHookRunnerWithRegistry(
    handlers.map((handler) => ({ hookName: "reply_payload_sending", handler })),
  ).runner;
}

function send(
  runner: ReturnType<typeof createRunner>,
  payload: PluginHookReplyPayload = replyPayloadSendingEvent.payload,
) {
  return runner.runReplyPayloadSending(
    { ...replyPayloadSendingEvent, payload },
    replyPayloadSendingCtx,
  );
}

function editPayload(edit: (payload: PluginHookReplyPayload) => ReplyPayload) {
  return vi.fn(async (event: { payload: PluginHookReplyPayload }) => {
    expect("trustedLocalMedia" in event.payload).toBe(false);
    return { payload: edit(event.payload) };
  });
}

describe("outbound hook runners", () => {
  it.each(["message_sending", "reply_payload_sending"] as const)(
    "%s fails open after the default per-handler timeout",
    async (hookName) => {
      const next =
        hookName === "message_sending"
          ? { content: "after timeout" }
          : { payload: { text: "after timeout" }, cancel: undefined, reason: undefined };
      const { runner } = createHookRunnerWithRegistry(
        [() => new Promise<never>(() => {}), async () => next].map((handler) => ({
          hookName,
          handler,
        })),
      );
      const resultPromise =
        hookName === "message_sending"
          ? runner.runMessageSending(messageEvent, messageCtx)
          : send(runner);
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(resultPromise).resolves.toEqual(next);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("message_sending forwards cancellation metadata", async () => {
    const hookResult = { cancel: true, cancelReason: "policy", metadata: { owner: "agent-2" } };
    const handler = vi.fn().mockReturnValue(hookResult);
    const { runner } = createHookRunnerWithRegistry([{ hookName: "message_sending", handler }]);
    await expect(runner.runMessageSending(messageEvent, messageCtx)).resolves.toEqual(hookResult);
    expect(handler).toHaveBeenCalledWith(messageEvent, messageCtx);
  });

  it("preserves a handler-specific timeout longer than the default", async () => {
    const handler = vi.fn(
      () =>
        new Promise<{ content: string }>((resolve) => {
          setTimeout(() => resolve({ content: "slow result" }), 16_000);
        }),
    );
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "message_sending", handler, timeoutMs: 20_000 },
    ]);
    const resultPromise = runner.runMessageSending(messageEvent, messageCtx);
    const settled = vi.fn();
    void resultPromise.then(settled);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(resultPromise).resolves.toEqual({ content: "slow result" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("message_sent forwards the delivery outcome", async () => {
    const event = { to: "user-123", content: "hello", success: false, error: "timeout" };
    const handler = vi.fn();
    const { runner } = createHookRunnerWithRegistry([{ hookName: "message_sent", handler }]);
    await runner.runMessageSent(event, messageCtx);
    expect(handler).toHaveBeenCalledWith(event, messageCtx);
  });

  it("passes the latest payload between handlers while preserving internal metadata", async () => {
    const metadata = {
      assistantMessageIndex: 7,
      sourceReplyTranscriptMirror: {
        sessionKey: "agent:test:session",
        text: "hello",
        idempotencyKey: "mirror-1",
      },
    };
    const payload = {
      text: "hello",
      presentation: {
        blocks: [{ type: "buttons", buttons: [{ label: "Proceed", value: "action:proceed" }] }],
      },
    } satisfies ReplyPayload;
    const second = vi.fn(
      async (event: typeof replyPayloadSendingEvent, context: typeof replyPayloadSendingCtx) => {
        expect(event).toEqual({ ...replyPayloadSendingEvent, payload });
        expect(context).toEqual(replyPayloadSendingCtx);
        return { payload: { ...event.payload, text: `${event.payload.text}!` } };
      },
    );
    const result = await send(
      createRunner([async () => ({ payload }), second]),
      setReplyPayloadMetadata({ text: "hello" }, metadata),
    );
    expect(result).toEqual({
      payload: { ...payload, text: "hello!" },
      cancel: undefined,
      reason: undefined,
    });
    expect(getReplyPayloadMetadata(result?.payload as ReplyPayload)).toEqual(metadata);
  });

  it("stops at the first handler that cancels delivery", async () => {
    const second = vi.fn();
    expect(
      await send(createRunner([async () => ({ cancel: true, reason: "blocked" }), second])),
    ).toEqual({
      payload: { text: "hello" },
      cancel: true,
      reason: "blocked",
    });
    expect(second).not.toHaveBeenCalled();
  });

  it.each([
    { trusted: false, replaceMedia: false },
    { trusted: true, replaceMedia: false },
    { trusted: true, replaceMedia: true },
  ])(
    "keeps media trust host-owned ($trusted, replace=$replaceMedia)",
    async ({ trusted, replaceMedia }) => {
      const mediaUrl = "file:///tmp/plugin-replaced.wav";
      const handler = editPayload((payload) => ({
        ...payload,
        text: "plugin changed",
        trustedLocalMedia: true,
        ...(replaceMedia ? { mediaUrl } : {}),
      }));
      const payload: ReplyPayload = {
        text: "hello",
        ...(trusted ? { trustedLocalMedia: true } : {}),
        ...(replaceMedia ? { mediaUrl: "file:///tmp/runtime-owned.wav" } : {}),
      };
      const result = await send(createRunner([handler]), payload);
      expect(result?.payload).toEqual({
        text: "plugin changed",
        ...(trusted && !replaceMedia ? { trustedLocalMedia: true } : {}),
        ...(replaceMedia ? { mediaUrl } : {}),
      });
    },
  );
});
