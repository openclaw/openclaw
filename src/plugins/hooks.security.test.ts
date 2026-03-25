import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { addTestHook } from "./hooks.test-helpers.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";
import type {
  PluginHookBeforeToolCallResult,
  PluginHookMessageSendingResult,
  PluginHookRegistration,
} from "./types.js";

function addBeforeToolCallHook(
  registry: PluginRegistry,
  pluginId: string,
  handler: () => PluginHookBeforeToolCallResult | Promise<PluginHookBeforeToolCallResult>,
  priority?: number,
) {
  addTestHook({
    registry,
    pluginId,
    hookName: "before_tool_call",
    handler: handler as PluginHookRegistration["handler"],
    priority,
  });
}

function addMessageSendingHook(
  registry: PluginRegistry,
  pluginId: string,
  handler: () => PluginHookMessageSendingResult | Promise<PluginHookMessageSendingResult>,
  priority?: number,
) {
  addTestHook({
    registry,
    pluginId,
    hookName: "message_sending",
    handler: handler as PluginHookRegistration["handler"],
    priority,
  });
}

const toolEvent = { toolName: "bash", params: { command: "echo hello" } };
const toolCtx = { toolName: "bash" };
const messageEvent = { to: "user-1", content: "hello" };
const messageCtx = { channelId: "telegram" };

describe("before_tool_call terminal block semantics", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  it("keeps block=true when a lower-priority hook returns block=false", async () => {
    addBeforeToolCallHook(registry, "high", () => ({ block: true, blockReason: "dangerous" }), 100);
    addBeforeToolCallHook(registry, "low", () => ({ block: false }), 10);

    const runner = createHookRunner(registry);
    const result = await runner.runBeforeToolCall(toolEvent, toolCtx);

    expect(result?.block).toBe(true);
    expect(result?.blockReason).toBe("dangerous");
  });

  it("treats explicit block=false as no-op when no prior hook blocked", async () => {
    addBeforeToolCallHook(registry, "single", () => ({ block: false }), 10);

    const runner = createHookRunner(registry);
    const result = await runner.runBeforeToolCall(toolEvent, toolCtx);

    expect(result?.block).toBeUndefined();
  });

  it("treats passive handler output as no-op for prior block", async () => {
    addBeforeToolCallHook(registry, "high", () => ({ block: true, blockReason: "blocked" }), 100);
    addBeforeToolCallHook(registry, "passive", () => ({}), 10);

    const runner = createHookRunner(registry);
    const result = await runner.runBeforeToolCall(toolEvent, toolCtx);

    expect(result?.block).toBe(true);
    expect(result?.blockReason).toBe("blocked");
  });

  it("short-circuits lower-priority hooks after block=true", async () => {
    const high = vi.fn().mockReturnValue({ block: true, blockReason: "stop" });
    const low = vi.fn().mockReturnValue({ params: { injected: true } });
    addBeforeToolCallHook(registry, "high", high, 100);
    addBeforeToolCallHook(registry, "low", low, 10);

    const runner = createHookRunner(registry);
    const result = await runner.runBeforeToolCall(toolEvent, toolCtx);

    expect(result?.block).toBe(true);
    expect(high).toHaveBeenCalledTimes(1);
    expect(low).not.toHaveBeenCalled();
  });

  it("preserves deterministic same-priority registration order when terminal hook runs first", async () => {
    const first = vi.fn().mockReturnValue({ block: true, blockReason: "first" });
    const second = vi.fn().mockReturnValue({ block: true, blockReason: "second" });
    addBeforeToolCallHook(registry, "first", first, 50);
    addBeforeToolCallHook(registry, "second", second, 50);

    const runner = createHookRunner(registry);
    const result = await runner.runBeforeToolCall(toolEvent, toolCtx);

    expect(result?.block).toBe(true);
    expect(result?.blockReason).toBe("first");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("stops before lower-priority throwing hooks when catchErrors is false", async () => {
    addBeforeToolCallHook(registry, "high", () => ({ block: true, blockReason: "guard" }), 100);
    const low = vi.fn().mockImplementation(() => {
      throw new Error("should not run");
    });
    addBeforeToolCallHook(registry, "low", low, 10);

    const runner = createHookRunner(registry, { catchErrors: false });
    const result = await runner.runBeforeToolCall(toolEvent, toolCtx);

    expect(result?.block).toBe(true);
    expect(low).not.toHaveBeenCalled();
  });

  it("respects block from a middle hook in a multi-handler chain", async () => {
    const low = vi.fn().mockReturnValue({ block: false });
    addBeforeToolCallHook(registry, "high-passive", () => ({}), 100);
    addBeforeToolCallHook(
      registry,
      "middle-block",
      () => ({ block: true, blockReason: "mid" }),
      50,
    );
    addBeforeToolCallHook(registry, "low-false", low, 0);

    const runner = createHookRunner(registry);
    const result = await runner.runBeforeToolCall(toolEvent, toolCtx);

    expect(result?.block).toBe(true);
    expect(result?.blockReason).toBe("mid");
    expect(low).not.toHaveBeenCalled();
  });
});

describe("message_sending terminal cancel semantics", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  it("keeps cancel=true when a lower-priority hook returns cancel=false", async () => {
    addMessageSendingHook(registry, "high", () => ({ cancel: true, content: "guarded" }), 100);
    addMessageSendingHook(registry, "low", () => ({ cancel: false, content: "override" }), 10);

    const runner = createHookRunner(registry);
    const result = await runner.runMessageSending(messageEvent, messageCtx);

    expect(result?.cancel).toBe(true);
    expect(result?.content).toBe("guarded");
  });

  it("treats explicit cancel=false as no-op when no prior hook canceled", async () => {
    addMessageSendingHook(registry, "single", () => ({ cancel: false }), 10);

    const runner = createHookRunner(registry);
    const result = await runner.runMessageSending(messageEvent, messageCtx);

    expect(result?.cancel).toBeUndefined();
  });

  it("treats passive handler output as no-op for prior cancel", async () => {
    addMessageSendingHook(registry, "high", () => ({ cancel: true }), 100);
    addMessageSendingHook(registry, "passive", () => ({}), 10);

    const runner = createHookRunner(registry);
    const result = await runner.runMessageSending(messageEvent, messageCtx);

    expect(result?.cancel).toBe(true);
  });

  it("short-circuits lower-priority hooks after cancel=true", async () => {
    const high = vi.fn().mockReturnValue({ cancel: true, content: "guarded" });
    const low = vi.fn().mockReturnValue({ cancel: false, content: "mutated" });
    addMessageSendingHook(registry, "high", high, 100);
    addMessageSendingHook(registry, "low", low, 10);

    const runner = createHookRunner(registry);
    const result = await runner.runMessageSending(messageEvent, messageCtx);

    expect(result?.cancel).toBe(true);
    expect(result?.content).toBe("guarded");
    expect(high).toHaveBeenCalledTimes(1);
    expect(low).not.toHaveBeenCalled();
  });

  it("preserves deterministic same-priority registration order for non-terminal merges", async () => {
    addMessageSendingHook(registry, "first", () => ({ content: "first" }), 50);
    addMessageSendingHook(registry, "second", () => ({ content: "second" }), 50);

    const runner = createHookRunner(registry);
    const result = await runner.runMessageSending(messageEvent, messageCtx);

    expect(result?.content).toBe("second");
  });

  it("stops before lower-priority throwing hooks when catchErrors is false", async () => {
    addMessageSendingHook(registry, "high", () => ({ cancel: true }), 100);
    const low = vi.fn().mockImplementation(() => {
      throw new Error("should not run");
    });
    addMessageSendingHook(registry, "low", low, 10);

    const runner = createHookRunner(registry, { catchErrors: false });
    const result = await runner.runMessageSending(messageEvent, messageCtx);

    expect(result?.cancel).toBe(true);
    expect(low).not.toHaveBeenCalled();
  });

  it("allows lower-priority cancel when higher-priority hooks are non-terminal", async () => {
    addMessageSendingHook(registry, "high-passive", () => ({ content: "rewritten" }), 100);
    addMessageSendingHook(registry, "low-cancel", () => ({ cancel: true }), 10);

    const runner = createHookRunner(registry);
    const result = await runner.runMessageSending(messageEvent, messageCtx);

    expect(result?.cancel).toBe(true);
  });
});
