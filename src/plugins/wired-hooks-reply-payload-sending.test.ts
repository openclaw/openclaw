/** Tests reply payload sending through wired plugin hook flows. */
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../auto-reply/reply-payload.js";
import type { PluginHookReplyPayload } from "./hook-types.js";
import { createHookRunnerWithRegistry } from "./hooks.test-fixtures.js";

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

describe("reply_payload_sending hook runner", () => {
  it("fails open after the default per-handler timeout", async () => {
    vi.useFakeTimers();
    try {
      const logger = { warn: vi.fn(), error: vi.fn() };
      const firstStarted = createDeferred();
      const first = vi.fn(() => {
        firstStarted.resolve();
        return new Promise<never>(() => {});
      });
      const second = vi.fn().mockResolvedValue({ payload: { text: "after timeout" } });
      const runner = createRunner([first, second], { logger });
      const resultPromise = send(runner);
      await firstStarted.promise;
      await vi.advanceTimersByTimeAsync(15_000);

      await expect(resultPromise).resolves.toEqual({
        payload: { text: "after timeout" },
        cancel: undefined,
        reason: undefined,
      });
      expect(second).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        "[hooks] reply_payload_sending handler from test-plugin failed: timed out after 15000ms",
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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

  it("does not expose trusted local media to plugins", async () => {
    const handler = editPayload((payload) => ({
      ...payload,
      text: "plugin changed",
      trustedLocalMedia: true,
    }));
    const result = await send(createRunner([handler]));

    expect(handler).toHaveBeenCalledTimes(1);
    expect((result?.payload as ReplyPayload | undefined)?.trustedLocalMedia).toBeUndefined();
    expect(result?.payload).toMatchObject({ text: "plugin changed" });
  });

  it("preserves runtime-owned trusted local media across plugin edits", async () => {
    const handler = editPayload((payload) => ({ ...payload, text: "plugin changed" }));
    const result = await send(createRunner([handler]), {
      text: "hello",
      trustedLocalMedia: true,
    } as unknown as PluginHookReplyPayload);

    expect(handler).toHaveBeenCalledTimes(1);
    expect((result?.payload as ReplyPayload | undefined)?.trustedLocalMedia).toBe(true);
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
