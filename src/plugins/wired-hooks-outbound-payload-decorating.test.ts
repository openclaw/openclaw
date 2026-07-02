/** Tests outbound payload decoration through wired plugin hook flows. */
import { describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import { createHookRunnerWithRegistry } from "./hooks.test-helpers.js";

const outboundDecoratingEvent = {
  payload: { text: "hello" } satisfies ReplyPayload,
  channel: "telegram",
  to: "chat-123",
  accountId: "default",
  threadId: "thread-1",
  replyToId: "reply-1",
  sessionKey: "agent:test:session",
  runId: "run-123",
  outboundMetadata: {
    presentationBlocks: [
      {
        type: "buttons" as const,
        buttons: [{ label: "Yes", action: { type: "callback" as const, value: "reply:yes" } }],
      },
    ],
  },
};

const outboundDecoratingCtx = {
  channelId: "telegram",
  accountId: "default",
  conversationId: "chat-123",
  sessionKey: "agent:test:session",
};

describe("outbound_payload_decorating hook runner", () => {
  it("passes hidden outbound metadata between handlers and appends decorations", async () => {
    const first = vi.fn().mockResolvedValue({
      outboundMetadata: {
        presentationBlocks: [
          {
            type: "buttons",
            buttons: [{ label: "Later", action: { type: "callback", value: "reply:later" } }],
          },
        ],
      },
    });
    const second = vi.fn().mockImplementation(async (event: typeof outboundDecoratingEvent) => ({
      decorations: {
        presentationBlocks: event.outboundMetadata?.presentationBlocks,
      },
    }));
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "outbound_payload_decorating", handler: first },
      { hookName: "outbound_payload_decorating", handler: second },
    ]);

    const result = await runner.runOutboundPayloadDecorating(
      outboundDecoratingEvent,
      outboundDecoratingCtx,
    );

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith(
      expect.objectContaining({
        outboundMetadata: {
          presentationBlocks: [
            {
              type: "buttons",
              buttons: [{ label: "Later", action: { type: "callback", value: "reply:later" } }],
            },
          ],
        },
      }),
      outboundDecoratingCtx,
    );
    expect(result).toEqual({
      decorations: {
        presentationBlocks: [
          {
            type: "buttons",
            buttons: [{ label: "Later", action: { type: "callback", value: "reply:later" } }],
          },
        ],
      },
      outboundMetadata: {
        presentationBlocks: [
          {
            type: "buttons",
            buttons: [{ label: "Later", action: { type: "callback", value: "reply:later" } }],
          },
        ],
      },
    });
  });

  it("does not expose trusted local media to decorators", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "outbound_payload_decorating", handler },
    ]);

    await runner.runOutboundPayloadDecorating(
      {
        ...outboundDecoratingEvent,
        payload: {
          text: "hello",
          mediaUrl: "file:///tmp/local.png",
          trustedLocalMedia: true,
        } as ReplyPayload,
      },
      outboundDecoratingCtx,
    );

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          text: "hello",
          mediaUrl: "file:///tmp/local.png",
        },
      }),
      outboundDecoratingCtx,
    );
  });

  it("continues after handler errors", async () => {
    const logger = {
      warn: vi.fn(),
      error: vi.fn(),
    };
    const failing = vi.fn().mockRejectedValue(new Error("boom"));
    const succeeding = vi.fn().mockResolvedValue({
      decorations: {
        presentationBlocks: [
          {
            type: "buttons",
            buttons: [{ label: "OK", action: { type: "callback", value: "reply:ok" } }],
          },
        ],
      },
    });
    const { runner } = createHookRunnerWithRegistry(
      [
        { hookName: "outbound_payload_decorating", handler: failing },
        { hookName: "outbound_payload_decorating", handler: succeeding },
      ],
      { logger },
    );

    const result = await runner.runOutboundPayloadDecorating(
      outboundDecoratingEvent,
      outboundDecoratingCtx,
    );

    expect(result?.decorations?.presentationBlocks).toEqual([
      {
        type: "buttons",
        buttons: [{ label: "OK", action: { type: "callback", value: "reply:ok" } }],
      },
    ]);
    expect(logger.error).toHaveBeenCalledWith(
      "[hooks] outbound_payload_decorating handler from test-plugin failed: boom",
    );
  });
});
