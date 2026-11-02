/** Tests reply payload sending through wired plugin hook flows. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
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

const replyPayloadSendingCtx = {
  channelId: "telegram",
  accountId: "default",
  conversationId: "conv-1",
  sessionKey: "agent:test:session",
  runId: "run-123",
};

function createRunner(
  handlers: Parameters<typeof createHookRunnerWithRegistry>[0][number]["handler"][],
  options?: Parameters<typeof createHookRunnerWithRegistry>[1],
) {
  return createHookRunnerWithRegistry(
    handlers.map((handler) => ({ hookName: "reply_payload_sending", handler })),
    options,
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
  return vi.fn().mockImplementation(async (event: { payload: PluginHookReplyPayload }) => {
    expect("trustedLocalMedia" in event.payload).toBe(false);
    return { payload: edit(event.payload) };
  });
}

describe("outbound hook runners", () => {
  it.each([
    {
      hookName: "message_sending",
      next: { content: "after timeout" },
      expected: { content: "after timeout" },
      invoke: (runner: ReturnType<typeof createRunner>) =>
        runner.runMessageSending(messageEvent, messageCtx),
    },
    {
      hookName: "reply_payload_sending",
      next: { payload: { text: "after timeout" } },
      expected: { payload: { text: "after timeout" }, cancel: undefined, reason: undefined },
      invoke: send,
    },
  ])(
    "$hookName fails open after the default per-handler timeout",
    async ({ hookName, next, expected, invoke }) => {
      const logger = { warn: vi.fn(), error: vi.fn() };
      const firstStarted = createDeferred();
      const first = vi.fn(() => {
        firstStarted.resolve();
        return new Promise<never>(() => {});
      });
      const second = vi.fn().mockResolvedValue(next);
      const { runner } = createHookRunnerWithRegistry(
        [first, second].map((handler) => ({ hookName, handler })),
        { logger },
      );
      const resultPromise = invoke(runner);
      await firstStarted.promise;
      await vi.advanceTimersByTimeAsync(15_000);

      await expect(resultPromise).resolves.toEqual(expected);
      expect(second).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        `[hooks] ${hookName} handler from test-plugin failed: timed out after 15000ms`,
      );
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    { content: "modified content" },
    { cancel: true, cancelReason: "policy", metadata: { owner: "agent-2" } },
  ])("message_sending returns %j", async (hookResult) => {
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
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(resultPromise).resolves.toEqual({ content: "slow result" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { to: "user-123", content: "hello", success: true },
    { to: "user-123", content: "hello", success: false, error: "timeout" },
  ])("message_sent delivers %j", async (event) => {
    const handler = vi.fn();
    const { runner } = createHookRunnerWithRegistry([{ hookName: "message_sent", handler }]);
    await runner.runMessageSent(event, messageCtx);
    expect(handler).toHaveBeenCalledWith(event, messageCtx);
  });

  it("passes the latest payload between handlers", async () => {
    const payload = {
      text: "hello",
      presentation: {
        blocks: [{ type: "buttons", buttons: [{ label: "Proceed", value: "action:proceed" }] }],
      },
    } satisfies ReplyPayload;
    const first = vi.fn().mockResolvedValue({ payload });
    const second = vi.fn().mockImplementation(async (event: { payload: ReplyPayload }) => ({
      payload: {
        ...event.payload,
        text: `${event.payload.text ?? ""}!`,
      },
    }));
    const result = await send(createRunner([first, second]));

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith(
      { ...replyPayloadSendingEvent, payload },
      replyPayloadSendingCtx,
    );
    expect(result).toEqual({
      payload: { ...payload, text: "hello!" },
      cancel: undefined,
      reason: undefined,
    });
  });

  it("stops at the first handler that cancels delivery", async () => {
    const first = vi.fn().mockResolvedValue({ cancel: true, reason: "blocked" });
    const second = vi.fn();
    const result = await send(createRunner([first, second]));

    expect(result).toEqual({
      payload: { text: "hello" },
      cancel: true,
      reason: "blocked",
    });
    expect(second).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps media trust host-owned (trusted=%s)", async (trusted) => {
    const handler = editPayload((payload) => ({
      ...payload,
      text: "plugin changed",
      trustedLocalMedia: true,
    }));
    const payload = trusted
      ? ({ text: "hello", trustedLocalMedia: true } as unknown as PluginHookReplyPayload)
      : replyPayloadSendingEvent.payload;
    const result = await send(createRunner([handler]), payload);

    expect(handler).toHaveBeenCalledTimes(1);
    expect((result?.payload as ReplyPayload | undefined)?.trustedLocalMedia).toBe(
      trusted ? true : undefined,
    );
    expect(result?.payload).toMatchObject({ text: "plugin changed" });
  });

  it("preserves internal reply metadata across plugin edits", async () => {
    const handler = vi
      .fn()
      .mockImplementation(async (event: { payload: PluginHookReplyPayload }) => ({
        payload: { ...event.payload, text: "plugin changed" },
      }));
    const metadata = {
      assistantMessageIndex: 7,
      sourceReplyTranscriptMirror: {
        sessionKey: "agent:test:session",
        text: "hello",
        idempotencyKey: "mirror-1",
      },
    };
    const payload = setReplyPayloadMetadata({ text: "hello" } satisfies ReplyPayload, metadata);
    const result = await send(createRunner([handler]), payload);

    expect(result?.payload).toMatchObject({ text: "plugin changed" });
    expect(getReplyPayloadMetadata(result?.payload as ReplyPayload)).toEqual(metadata);
  });

  it("drops trusted local media when plugins change media refs", async () => {
    const handler = editPayload((payload) => ({
      ...payload,
      mediaUrl: "file:///tmp/plugin-replaced.wav",
    }));
    const result = await send(createRunner([handler]), {
      text: "hello",
      mediaUrl: "file:///tmp/runtime-owned.wav",
      trustedLocalMedia: true,
    } as unknown as PluginHookReplyPayload);

    expect((result?.payload as ReplyPayload | undefined)?.trustedLocalMedia).toBeUndefined();
    expect(result?.payload).toMatchObject({
      text: "hello",
      mediaUrl: "file:///tmp/plugin-replaced.wav",
    });
  });
});
