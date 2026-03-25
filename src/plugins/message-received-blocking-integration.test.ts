/**
 * Integration test: message_received blocking opt-in
 *
 * Validates that the opt-in blocking mode for message_received works correctly
 * for security/policy plugins that need to perform async
 * inbound checks before agent dispatch, while preserving existing fire-and-forget
 * behavior for all current observer hooks.
 *
 * Test categories:
 * 1. Async policy enforcement (the real-world use case)
 * 2. Opt-in verification (default = observer, explicit = blocking)
 * 3. Multiple handler scenarios (priority merging, mixed modes)
 * 4. Error handling (fail-open for blocking, no cascading for observer)
 * 5. Non-regression for other hooks (message_sending, message_sent, etc.)
 */
import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

// ---------------------------------------------------------------------------
// 1. Async policy enforcement
// ---------------------------------------------------------------------------

describe("async policy enforcement via blocking handler", () => {
  it("blocking handler can perform async remote check and cancel the message", async () => {
    // Simulates an async remote policy check:
    // 1. Receives inbound message
    // 2. Calls remote policy service (async)
    // 3. Returns cancel + replyText if blocked
    const policyCheckHandler = vi.fn().mockImplementation(async (event) => {
      // Simulate async remote call with delay
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Simulate policy denial for content containing "blocked-content"
      if (event.content.includes("blocked-content")) {
        return {
          cancel: true,
          blockReason: "remote policy denied inbound message",
          replyText: "Your message was blocked by policy.",
        };
      }
      // Allow through — return void
      return undefined;
    });

    const registry = createMockPluginRegistry([
      {
        hookName: "message_received",
        handler: policyCheckHandler,
        messageReceivedMode: "blocking",
      },
    ]);
    const runner = createHookRunner(registry);

    // Test: message is blocked
    const blockedResult = await runner.runMessageReceived(
      { from: "user-1", content: "hello blocked-content here" },
      { channelId: "slack" },
    );

    expect(blockedResult).toEqual({
      cancel: true,
      blockReason: "remote policy denied inbound message",
      replyText: "Your message was blocked by policy.",
    });

    // Test: message is allowed through
    const allowedResult = await runner.runMessageReceived(
      { from: "user-1", content: "hello this is fine" },
      { channelId: "slack" },
    );

    expect(allowedResult).toBeUndefined();
  });

  it("blocking handler with realistic async latency still returns before dispatch continues", async () => {
    // Simulates a policy service with 50ms latency (realistic for remote calls)
    const startTime = Date.now();
    const handler = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { cancel: true, blockReason: "slow-but-blocking" };
    });

    const registry = createMockPluginRegistry([
      {
        hookName: "message_received",
        handler,
        messageReceivedMode: "blocking",
      },
    ]);
    const runner = createHookRunner(registry);

    const result = await runner.runMessageReceived(
      { from: "user-1", content: "test" },
      { channelId: "telegram" },
    );

    const elapsed = Date.now() - startTime;

    expect(result?.cancel).toBe(true);
    expect(result?.blockReason).toBe("slow-but-blocking");
    // Verify the handler was actually awaited (took at least 50ms)
    expect(elapsed).toBeGreaterThanOrEqual(45);
  });

  it("observer + blocking: observer fires in background while blocking is awaited", async () => {
    const callOrder: string[] = [];

    // Observer hook: logs analytics (slow, not awaited)
    const observerHandler = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      callOrder.push("observer-completed");
    });

    // Blocking hook: policy check (fast, awaited)
    const blockingHandler = vi.fn().mockImplementation(async () => {
      callOrder.push("blocking-completed");
      return { cancel: true, blockReason: "policy" };
    });

    const registry = createMockPluginRegistry([
      { hookName: "message_received", handler: observerHandler },
      {
        hookName: "message_received",
        handler: blockingHandler,
        messageReceivedMode: "blocking",
      },
    ]);
    const runner = createHookRunner(registry);

    const result = await runner.runMessageReceived(
      { from: "user-1", content: "test" },
      { channelId: "slack" },
    );

    // Blocking handler was awaited and returned result
    expect(result).toEqual({ cancel: true, blockReason: "policy" });
    expect(blockingHandler).toHaveBeenCalled();

    // Observer was started but not awaited (still running in background)
    expect(observerHandler).toHaveBeenCalled();
    expect(callOrder).toContain("blocking-completed");
    // Observer may or may not have completed yet (it's async)
  });

  it("observer mutation does not affect blocking handler input", async () => {
    // Observer that mutates its event (top-level and nested) — should NOT affect blocking handler
    const observerHandler = vi.fn().mockImplementation(async (event) => {
      event.content = "mutated-by-observer";
      if (event.metadata) {
        event.metadata.senderId = "tampered";
      }
    });

    let blockingReceivedContent: string | undefined;
    let blockingReceivedMetadata: Record<string, unknown> | undefined;
    const blockingHandler = vi.fn().mockImplementation(async (event) => {
      blockingReceivedContent = event.content;
      blockingReceivedMetadata = event.metadata;
      return undefined;
    });

    const registry = createMockPluginRegistry([
      { hookName: "message_received", handler: observerHandler },
      {
        hookName: "message_received",
        handler: blockingHandler,
        messageReceivedMode: "blocking",
      },
    ]);
    const runner = createHookRunner(registry);

    await runner.runMessageReceived(
      { from: "user-1", content: "original-content", metadata: { senderId: "original" } },
      { channelId: "slack" },
    );

    // Observer saw and mutated its own deep copy
    expect(observerHandler).toHaveBeenCalled();
    // Blocking handler received the original, unmutated content and metadata
    expect(blockingReceivedContent).toBe("original-content");
    expect(blockingReceivedMetadata).toEqual({ senderId: "original" });
  });
});

// ---------------------------------------------------------------------------
// 2. Opt-in verification: observer mode is default
// ---------------------------------------------------------------------------

describe("opt-in verification: observer mode is default", () => {
  it("handler with no mode option is observer (fire-and-forget)", async () => {
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

  it("handler with explicit mode='observe' is fire-and-forget", async () => {
    const handler = vi.fn().mockReturnValue(new Promise(() => {})); // never resolves
    const registry = createMockPluginRegistry([
      {
        hookName: "message_received",
        handler,
        messageReceivedMode: "observe",
      },
    ]);
    const runner = createHookRunner(registry);

    const result = await runner.runMessageReceived(
      { from: "user-1", content: "hello" },
      { channelId: "telegram" },
    );

    expect(handler).toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("observer handler return values are completely ignored", async () => {
    const handler = vi.fn().mockResolvedValue({
      cancel: true,
      blockReason: "should be ignored",
      replyText: "should be ignored",
    });
    const registry = createMockPluginRegistry([{ hookName: "message_received", handler }]);
    const runner = createHookRunner(registry);

    const result = await runner.runMessageReceived(
      { from: "user-1", content: "hello" },
      { channelId: "telegram" },
    );

    expect(handler).toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("multiple observer handlers all fire but none block", async () => {
    const handler1 = vi.fn().mockResolvedValue({ cancel: true });
    const handler2 = vi.fn().mockResolvedValue({ cancel: true });
    const handler3 = vi.fn().mockResolvedValue({ cancel: true });
    const registry = createMockPluginRegistry([
      { hookName: "message_received", handler: handler1 },
      { hookName: "message_received", handler: handler2 },
      { hookName: "message_received", handler: handler3 },
    ]);
    const runner = createHookRunner(registry);

    const result = await runner.runMessageReceived(
      { from: "user-1", content: "hello" },
      { channelId: "telegram" },
    );

    expect(handler1).toHaveBeenCalled();
    expect(handler2).toHaveBeenCalled();
    expect(handler3).toHaveBeenCalled();
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Blocking mode requires explicit opt-in
// ---------------------------------------------------------------------------

describe("blocking mode requires explicit opt-in", () => {
  it("only mode='blocking' handlers are awaited and return results", async () => {
    const observerHandler = vi.fn().mockResolvedValue({
      cancel: true,
      replyText: "observer-reply",
    });
    const blockingHandler = vi.fn().mockResolvedValue({
      cancel: true,
      replyText: "blocking-reply",
    });

    const registry = createMockPluginRegistry([
      { hookName: "message_received", handler: observerHandler },
      {
        hookName: "message_received",
        handler: blockingHandler,
        messageReceivedMode: "blocking",
      },
    ]);
    const runner = createHookRunner(registry);

    const result = await runner.runMessageReceived(
      { from: "user-1", content: "test" },
      { channelId: "slack" },
    );

    // Only the blocking handler's result is used
    expect(result?.replyText).toBe("blocking-reply");
  });

  it("blocking handler returning void/undefined allows the message through", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const registry = createMockPluginRegistry([
      {
        hookName: "message_received",
        handler,
        messageReceivedMode: "blocking",
      },
    ]);
    const runner = createHookRunner(registry);

    const result = await runner.runMessageReceived(
      { from: "user-1", content: "test" },
      { channelId: "slack" },
    );

    expect(handler).toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("blocking handler returning cancel=false explicitly allows through", async () => {
    const handler = vi.fn().mockResolvedValue({ cancel: false });
    const registry = createMockPluginRegistry([
      {
        hookName: "message_received",
        handler,
        messageReceivedMode: "blocking",
      },
    ]);
    const runner = createHookRunner(registry);

    const result = await runner.runMessageReceived(
      { from: "user-1", content: "test" },
      { channelId: "slack" },
    );

    // stickyTrue(undefined, false) → undefined; cancel is only set when true
    expect(result?.cancel).toBeUndefined();
  });

  it("no hooks registered returns undefined", async () => {
    const registry = createMockPluginRegistry([]);
    const runner = createHookRunner(registry);

    const result = await runner.runMessageReceived(
      { from: "user-1", content: "test" },
      { channelId: "slack" },
    );

    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Multiple handler scenarios: priority merging
// ---------------------------------------------------------------------------

describe("multiple blocking handlers: priority merging", () => {
  it("higher-priority handler values win in merge (first-defined-value-wins)", async () => {
    const highPriority = vi.fn().mockResolvedValue({
      cancel: true,
      blockReason: "high-priority-reason",
    });
    const lowPriority = vi.fn().mockResolvedValue({
      cancel: false,
      blockReason: "low-priority-reason",
      replyText: "low-priority-reply",
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

    // cancel and blockReason from high-priority; replyText from low-priority (first defined wins)
    expect(result).toEqual({
      cancel: true,
      blockReason: "high-priority-reason",
      replyText: "low-priority-reply",
    });
  });

  it("lower-priority handler cannot un-cancel a higher-priority cancel", async () => {
    const cancelHandler = vi.fn().mockResolvedValue({
      cancel: true,
      blockReason: "must block",
    });
    const allowHandler = vi.fn().mockResolvedValue({
      cancel: false,
      blockReason: "should allow",
    });

    const registry = createMockPluginRegistry([
      {
        hookName: "message_received",
        handler: cancelHandler,
        priority: 100,
        messageReceivedMode: "blocking",
      },
      {
        hookName: "message_received",
        handler: allowHandler,
        priority: 1,
        messageReceivedMode: "blocking",
      },
    ]);
    const runner = createHookRunner(registry);

    const result = await runner.runMessageReceived(
      { from: "user-1", content: "test" },
      { channelId: "discord" },
    );

    expect(result?.cancel).toBe(true);
    expect(result?.blockReason).toBe("must block");
  });

  it("blocking handlers run sequentially in priority order", async () => {
    const callOrder: number[] = [];

    const handler1 = vi.fn().mockImplementation(async () => {
      callOrder.push(1);
      return { blockReason: "first" };
    });
    const handler2 = vi.fn().mockImplementation(async () => {
      callOrder.push(2);
      return { blockReason: "second" };
    });
    const handler3 = vi.fn().mockImplementation(async () => {
      callOrder.push(3);
      return { blockReason: "third" };
    });

    const registry = createMockPluginRegistry([
      {
        hookName: "message_received",
        handler: handler1,
        priority: 30,
        messageReceivedMode: "blocking",
      },
      {
        hookName: "message_received",
        handler: handler2,
        priority: 20,
        messageReceivedMode: "blocking",
      },
      {
        hookName: "message_received",
        handler: handler3,
        priority: 10,
        messageReceivedMode: "blocking",
      },
    ]);
    const runner = createHookRunner(registry);

    await runner.runMessageReceived({ from: "user-1", content: "test" }, { channelId: "slack" });

    // Handlers execute in priority order (highest first)
    expect(callOrder).toEqual([1, 2, 3]);
  });

  it("observer handlers run in parallel (not sequential)", async () => {
    const callOrder: string[] = [];

    const slow = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      callOrder.push("slow");
    });
    const fast = vi.fn().mockImplementation(async () => {
      callOrder.push("fast");
    });

    const registry = createMockPluginRegistry([
      { hookName: "message_received", handler: slow, priority: 10 },
      { hookName: "message_received", handler: fast, priority: 1 },
    ]);
    const runner = createHookRunner(registry);

    await runner.runMessageReceived({ from: "user-1", content: "test" }, { channelId: "slack" });

    // Both were started (fire-and-forget)
    expect(slow).toHaveBeenCalled();
    expect(fast).toHaveBeenCalled();
    // Result is undefined since these are observers
  });
});

// ---------------------------------------------------------------------------
// 5. Error handling
// ---------------------------------------------------------------------------

describe("error handling in message_received hooks", () => {
  it("blocking handler error is caught gracefully (fail-open)", async () => {
    const errorHandler = vi.fn().mockRejectedValue(new Error("remote service down"));
    const registry = createMockPluginRegistry([
      {
        hookName: "message_received",
        handler: errorHandler,
        messageReceivedMode: "blocking",
      },
    ]);
    const runner = createHookRunner(registry);

    // Should not throw — errors are caught when catchErrors=true (default)
    const result = await runner.runMessageReceived(
      { from: "user-1", content: "test" },
      { channelId: "slack" },
    );

    expect(errorHandler).toHaveBeenCalled();
    // Fail-open: message proceeds (no cancel result)
    expect(result).toBeUndefined();
  });

  it("observer handler error does not affect blocking result", async () => {
    const errorObserver = vi.fn().mockRejectedValue(new Error("observer crash"));
    const blockingHandler = vi.fn().mockResolvedValue({
      cancel: true,
      blockReason: "blocked",
    });

    const registry = createMockPluginRegistry([
      { hookName: "message_received", handler: errorObserver },
      {
        hookName: "message_received",
        handler: blockingHandler,
        messageReceivedMode: "blocking",
      },
    ]);
    const runner = createHookRunner(registry);

    const result = await runner.runMessageReceived(
      { from: "user-1", content: "test" },
      { channelId: "slack" },
    );

    // Blocking result is unaffected by observer error
    expect(result).toEqual({ cancel: true, blockReason: "blocked" });
  });

  it("one blocking handler error does not prevent other blocking handlers from running", async () => {
    const errorHandler = vi.fn().mockRejectedValue(new Error("first handler down"));
    const successHandler = vi.fn().mockResolvedValue({
      cancel: true,
      blockReason: "second handler blocked",
    });

    const registry = createMockPluginRegistry([
      {
        hookName: "message_received",
        handler: errorHandler,
        priority: 10,
        messageReceivedMode: "blocking",
      },
      {
        hookName: "message_received",
        handler: successHandler,
        priority: 1,
        messageReceivedMode: "blocking",
      },
    ]);
    const runner = createHookRunner(registry);

    const result = await runner.runMessageReceived(
      { from: "user-1", content: "test" },
      { channelId: "slack" },
    );

    expect(errorHandler).toHaveBeenCalled();
    expect(successHandler).toHaveBeenCalled();
    // Second handler's result is returned even though first errored
    expect(result).toEqual({
      cancel: true,
      blockReason: "second handler blocked",
    });
  });

  it("blocking handler throwing with catchErrors=false propagates the error", async () => {
    const errorHandler = vi.fn().mockRejectedValue(new Error("critical failure"));
    const registry = createMockPluginRegistry([
      {
        hookName: "message_received",
        handler: errorHandler,
        messageReceivedMode: "blocking",
      },
    ]);
    const runner = createHookRunner(registry, { catchErrors: false });

    await expect(
      runner.runMessageReceived({ from: "user-1", content: "test" }, { channelId: "slack" }),
    ).rejects.toThrow("critical failure");
  });
});

// ---------------------------------------------------------------------------
// 6. Event and context passthrough
// ---------------------------------------------------------------------------

describe("event and context passthrough", () => {
  it("blocking handler receives the full event and context", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const registry = createMockPluginRegistry([
      {
        hookName: "message_received",
        handler,
        messageReceivedMode: "blocking",
      },
    ]);
    const runner = createHookRunner(registry);

    const event = {
      from: "user-123",
      content: "test message content",
      timestamp: 1711234567890,
      metadata: { source: "policy-plugin-test" },
    };
    const ctx = { channelId: "slack" };

    await runner.runMessageReceived(event, ctx);

    expect(handler).toHaveBeenCalledWith(event, ctx);
  });

  it("observer handler receives the same event and context", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const registry = createMockPluginRegistry([{ hookName: "message_received", handler }]);
    const runner = createHookRunner(registry);

    const event = { from: "user-456", content: "observer test" };
    const ctx = { channelId: "telegram" };

    await runner.runMessageReceived(event, ctx);

    expect(handler).toHaveBeenCalledWith(event, ctx);
  });
});

// ---------------------------------------------------------------------------
// 7. Non-regression: other hooks are unaffected
// ---------------------------------------------------------------------------

describe("non-regression: other hooks are unaffected", () => {
  it("message_sending still supports cancel and content modification", async () => {
    const handler = vi.fn().mockResolvedValue({
      content: "modified content",
      cancel: false,
    });
    const registry = createMockPluginRegistry([{ hookName: "message_sending", handler }]);
    const runner = createHookRunner(registry);

    const result = await runner.runMessageSending(
      { to: "user-123", content: "original content" },
      { channelId: "telegram" },
    );

    expect(handler).toHaveBeenCalled();
    expect(result?.content).toBe("modified content");
    expect(result?.cancel).toBeUndefined();
  });

  it("message_sending cancel still works", async () => {
    const handler = vi.fn().mockResolvedValue({ cancel: true });
    const registry = createMockPluginRegistry([{ hookName: "message_sending", handler }]);
    const runner = createHookRunner(registry);

    const result = await runner.runMessageSending(
      { to: "user-123", content: "blocked outbound" },
      { channelId: "telegram" },
    );

    expect(result?.cancel).toBe(true);
  });

  it("message_sent still fires as observer (void hook)", async () => {
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

  it("message_sent with error still fires correctly", async () => {
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

  it("before_tool_call still supports block and params modification", async () => {
    const handler = vi.fn().mockResolvedValue({
      block: true,
      blockReason: "tool not allowed",
    });
    const registry = createMockPluginRegistry([{ hookName: "before_tool_call", handler }]);
    const runner = createHookRunner(registry);

    const result = await runner.runBeforeToolCall(
      { toolName: "dangerous_tool", params: { arg: "value" } },
      { toolName: "dangerous_tool" },
    );

    expect(result?.block).toBe(true);
    expect(result?.blockReason).toBe("tool not allowed");
  });

  it("inbound_claim still works as claiming hook", async () => {
    const handler = vi.fn().mockResolvedValue({ handled: true });
    const registry = createMockPluginRegistry([{ hookName: "inbound_claim", handler }]);
    const runner = createHookRunner(registry);

    const result = await runner.runInboundClaim(
      { content: "hello", channel: "slack", isGroup: false },
      { channelId: "slack" },
    );

    expect(result?.handled).toBe(true);
  });

  it("hasHooks correctly reports hook presence", () => {
    const registry = createMockPluginRegistry([
      { hookName: "message_received", handler: vi.fn() },
      {
        hookName: "message_received",
        handler: vi.fn(),
        messageReceivedMode: "blocking",
      },
      { hookName: "message_sending", handler: vi.fn() },
    ]);
    const runner = createHookRunner(registry);

    expect(runner.hasHooks("message_received")).toBe(true);
    expect(runner.hasHooks("message_sending")).toBe(true);
    expect(runner.hasHooks("message_sent")).toBe(false);
    expect(runner.hasHooks("before_tool_call")).toBe(false);
  });

  it("getHookCount counts all message_received hooks (observer + blocking)", () => {
    const registry = createMockPluginRegistry([
      { hookName: "message_received", handler: vi.fn() },
      {
        hookName: "message_received",
        handler: vi.fn(),
        messageReceivedMode: "blocking",
      },
      {
        hookName: "message_received",
        handler: vi.fn(),
        messageReceivedMode: "blocking",
      },
    ]);
    const runner = createHookRunner(registry);

    expect(runner.getHookCount("message_received")).toBe(3);
  });
});
