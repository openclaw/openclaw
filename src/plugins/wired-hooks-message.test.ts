/**
 * Test: message_sending, message_sent, and message_received hook wiring
 *
 * Tests the hook runner methods directly since outbound delivery is deeply integrated.
 */
import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createHookRunnerWithRegistry, createMockPluginRegistry } from "./hooks.test-helpers.js";
import type {
  PluginHookMessageSendingEvent,
  PluginHookMessageSendingResult,
  PluginHookMessageSentEvent,
} from "./types.js";

async function expectMessageHookCall(params: {
  hookName: "message_sending" | "message_sent";
  event: PluginHookMessageSendingEvent | PluginHookMessageSentEvent;
  hookResult?: PluginHookMessageSendingResult;
  expectedResult?: PluginHookMessageSendingResult;
  channelCtx: { channelId: string };
}) {
  const handler =
    params.hookResult === undefined ? vi.fn() : vi.fn().mockReturnValue(params.hookResult);
  const { runner } = createHookRunnerWithRegistry([{ hookName: params.hookName, handler }]);

  if (params.hookName === "message_sending") {
    const result = await runner.runMessageSending(
      params.event as PluginHookMessageSendingEvent,
      params.channelCtx,
    );
    expect(result).toEqual(expect.objectContaining(params.expectedResult ?? {}));
  } else {
    await runner.runMessageSent(params.event as PluginHookMessageSentEvent, params.channelCtx);
  }

  expect(handler).toHaveBeenCalledWith(params.event, params.channelCtx);
}

describe("message_sending hook runner", () => {
  const demoChannelCtx = { channelId: "demo-channel" };
  it.each([
    {
      name: "runMessageSending invokes registered hooks and returns modified content",
      event: { to: "user-123", content: "original content" },
      hookResult: { content: "modified content" },
      expected: { content: "modified content" },
    },
    {
      name: "runMessageSending can cancel message delivery",
      event: { to: "user-123", content: "blocked" },
      hookResult: { cancel: true },
      expected: { cancel: true },
    },
  ] as const)("$name", async ({ event, hookResult, expected }) => {
    await expectMessageHookCall({
      hookName: "message_sending",
      event,
      hookResult,
      expectedResult: expected,
      channelCtx: demoChannelCtx,
    });
  });
});

describe("message_sent hook runner", () => {
  const demoChannelCtx = { channelId: "demo-channel" };

  it.each([
    {
      name: "runMessageSent invokes registered hooks with success=true",
      event: { to: "user-123", content: "hello", success: true },
    },
    {
      name: "runMessageSent invokes registered hooks with error on failure",
      event: { to: "user-123", content: "hello", success: false, error: "timeout" },
    },
  ] as const)("$name", async ({ event }) => {
    await expectMessageHookCall({
      hookName: "message_sent",
      event,
      channelCtx: demoChannelCtx,
    });
  });
});

describe("message_received hook runner", () => {
  it("observer mode (default) is non-blocking — slow handler does not block result", async () => {
    const handler = vi.fn().mockReturnValue(new Promise(() => {})); // never resolves
    const registry = createMockPluginRegistry([{ hookName: "message_received", handler }]);
    const runner = createHookRunner(registry);

    const result = await runner.runMessageReceived(
      { from: "user-1", content: "hello" },
      { channelId: "telegram" },
    );

    expect(handler).toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("observer handler return value is ignored even if it returns cancel", async () => {
    const handler = vi.fn().mockReturnValue({ cancel: true, replyText: "blocked" });
    const registry = createMockPluginRegistry([{ hookName: "message_received", handler }]);
    const runner = createHookRunner(registry);

    const result = await runner.runMessageReceived(
      { from: "user-1", content: "hello" },
      { channelId: "telegram" },
    );

    expect(handler).toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("blocking handler is awaited and returns merged cancel result", async () => {
    const observerHandler = vi.fn().mockReturnValue(new Promise(() => {})); // slow observer
    const blockingHandler = vi.fn().mockResolvedValue({
      cancel: true,
      blockReason: "policy denied",
      replyText: "Blocked by policy.",
    });
    const registry = createMockPluginRegistry([
      { hookName: "message_received", handler: observerHandler },
      { hookName: "message_received", handler: blockingHandler, messageReceivedMode: "blocking" },
    ]);
    const runner = createHookRunner(registry);

    const result = await runner.runMessageReceived(
      { from: "user-1", content: "hello" },
      { channelId: "telegram" },
    );

    expect(observerHandler).toHaveBeenCalled();
    expect(blockingHandler).toHaveBeenCalled();
    expect(result).toEqual({
      cancel: true,
      blockReason: "policy denied",
      replyText: "Blocked by policy.",
    });
  });

  it("multiple blocking handlers merge with higher-priority values winning", async () => {
    const highPriority = vi.fn().mockResolvedValue({
      cancel: true,
      blockReason: "high-priority reason",
    });
    const lowPriority = vi.fn().mockResolvedValue({
      cancel: false,
      blockReason: "low-priority reason",
      replyText: "low-priority reply",
    });
    const registry = createMockPluginRegistry([
      {
        hookName: "message_received",
        handler: highPriority,
        priority: 10,
        messageReceivedMode: "blocking",
      },
      {
        hookName: "message_received",
        handler: lowPriority,
        priority: 1,
        messageReceivedMode: "blocking",
      },
    ]);
    const runner = createHookRunner(registry);

    const result = await runner.runMessageReceived(
      { from: "user-1", content: "test" },
      { channelId: "discord" },
    );

    expect(result).toEqual({
      cancel: true,
      blockReason: "high-priority reason",
      replyText: "low-priority reply",
    });
  });
});
