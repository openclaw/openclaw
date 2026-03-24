/**
 * Test: message_sending, message_sent, and message_received hook wiring
 *
 * Tests the hook runner methods directly since outbound delivery is deeply integrated.
 */
import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

describe("message_sending hook runner", () => {
  it("runMessageSending invokes registered hooks and returns modified content", async () => {
    const handler = vi.fn().mockReturnValue({ content: "modified content" });
    const registry = createMockPluginRegistry([{ hookName: "message_sending", handler }]);
    const runner = createHookRunner(registry);

    const result = await runner.runMessageSending(
      { to: "user-123", content: "original content" },
      { channelId: "telegram" },
    );

    expect(handler).toHaveBeenCalledWith(
      { to: "user-123", content: "original content" },
      { channelId: "telegram" },
    );
    expect(result?.content).toBe("modified content");
  });

  it("runMessageSending can cancel message delivery", async () => {
    const handler = vi.fn().mockReturnValue({ cancel: true });
    const registry = createMockPluginRegistry([{ hookName: "message_sending", handler }]);
    const runner = createHookRunner(registry);

    const result = await runner.runMessageSending(
      { to: "user-123", content: "blocked" },
      { channelId: "telegram" },
    );

    expect(result?.cancel).toBe(true);
  });
});

describe("message_sent hook runner", () => {
  it("runMessageSent invokes registered hooks with success=true", async () => {
    const handler = vi.fn();
    const registry = createMockPluginRegistry([{ hookName: "message_sent", handler }]);
    const runner = createHookRunner(registry);

    await runner.runMessageSent(
      { to: "user-123", content: "hello", success: true },
      { channelId: "telegram" },
    );

    expect(handler).toHaveBeenCalledWith(
      { to: "user-123", content: "hello", success: true },
      { channelId: "telegram" },
    );
  });

  it("runMessageSent invokes registered hooks with error on failure", async () => {
    const handler = vi.fn();
    const registry = createMockPluginRegistry([{ hookName: "message_sent", handler }]);
    const runner = createHookRunner(registry);

    await runner.runMessageSent(
      { to: "user-123", content: "hello", success: false, error: "timeout" },
      { channelId: "telegram" },
    );

    expect(handler).toHaveBeenCalledWith(
      { to: "user-123", content: "hello", success: false, error: "timeout" },
      { channelId: "telegram" },
    );
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
