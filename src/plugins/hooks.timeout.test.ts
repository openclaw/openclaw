/**
 * Tests for per-handler hook timeout protection.
 *
 * Validates that a hanging plugin hook handler is terminated after the
 * configured timeout so it cannot permanently block agent runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { addTestHook, TEST_PLUGIN_AGENT_CTX } from "./hooks.test-helpers.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";
import type { PluginHookRegistration } from "./types.js";

const stubCtx = TEST_PLUGIN_AGENT_CTX;

describe("hook handler timeout", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // before_agent_start (modifying hook, sequential)
  // -----------------------------------------------------------------------

  it("completes normally when handler resolves within timeout", async () => {
    addTestHook({
      registry,
      pluginId: "fast-plugin",
      hookName: "before_agent_start",
      handler: (() =>
        Promise.resolve({ prependContext: "fast result" })) as PluginHookRegistration["handler"],
    });

    const runner = createHookRunner(registry, { hookTimeoutMs: 5000, catchErrors: true });
    const promise = runner.runBeforeAgentStart({ prompt: "hello" }, stubCtx);
    await vi.advanceTimersByTimeAsync(0);

    const result = await promise;
    expect(result?.prependContext).toBe("fast result");
  });

  it("skips a hanging before_agent_start handler after timeout and proceeds", async () => {
    const warnings: string[] = [];

    // This handler never resolves
    addTestHook({
      registry,
      pluginId: "hanging-plugin",
      hookName: "before_agent_start",
      handler: (() => new Promise(() => {})) as PluginHookRegistration["handler"],
    });

    const runner = createHookRunner(registry, {
      hookTimeoutMs: 100,
      catchErrors: true,
      logger: {
        debug: () => {},
        warn: (msg) => warnings.push(msg),
        error: (msg) => warnings.push(msg),
      },
    });

    const promise = runner.runBeforeAgentStart({ prompt: "hello" }, stubCtx);
    await vi.advanceTimersByTimeAsync(150);

    const result = await promise;

    // Handler timed out so no result is returned
    expect(result).toBeUndefined();

    // A warning/error should have been logged with the plugin name
    expect(warnings.some((w) => w.includes("hanging-plugin"))).toBe(true);
    expect(warnings.some((w) => w.includes("timed out"))).toBe(true);
  });

  it("other hooks still execute when one hangs", async () => {
    const warnings: string[] = [];

    // First handler (higher priority) returns normally
    addTestHook({
      registry,
      pluginId: "good-plugin",
      hookName: "before_agent_start",
      handler: (() =>
        Promise.resolve({
          prependContext: "good context",
        })) as PluginHookRegistration["handler"],
      priority: 10,
    });

    // Second handler (lower priority) hangs
    addTestHook({
      registry,
      pluginId: "bad-plugin",
      hookName: "before_agent_start",
      handler: (() => new Promise(() => {})) as PluginHookRegistration["handler"],
      priority: 1,
    });

    const runner = createHookRunner(registry, {
      hookTimeoutMs: 100,
      catchErrors: true,
      logger: {
        debug: () => {},
        warn: (msg) => warnings.push(msg),
        error: (msg) => warnings.push(msg),
      },
    });

    const promise = runner.runBeforeAgentStart({ prompt: "hello" }, stubCtx);
    await vi.advanceTimersByTimeAsync(150);

    const result = await promise;

    // The good plugin's result should be preserved
    expect(result?.prependContext).toBe("good context");
    // The bad plugin should have been logged
    expect(warnings.some((w) => w.includes("bad-plugin"))).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Void hooks (parallel execution)
  // -----------------------------------------------------------------------

  it("skips a hanging void hook handler after timeout", async () => {
    const warnings: string[] = [];
    let fastHandlerRan = false;

    addTestHook({
      registry,
      pluginId: "fast-void-plugin",
      hookName: "agent_end",
      handler: (() => {
        fastHandlerRan = true;
        return Promise.resolve();
      }) as PluginHookRegistration["handler"],
    });

    addTestHook({
      registry,
      pluginId: "hanging-void-plugin",
      hookName: "agent_end",
      handler: (() => new Promise(() => {})) as PluginHookRegistration["handler"],
    });

    const runner = createHookRunner(registry, {
      hookTimeoutMs: 100,
      catchErrors: true,
      logger: {
        debug: () => {},
        warn: (msg) => warnings.push(msg),
        error: (msg) => warnings.push(msg),
      },
    });

    const promise = runner.runAgentEnd({ messages: [], success: true }, stubCtx);
    await vi.advanceTimersByTimeAsync(150);
    await promise;

    expect(fastHandlerRan).toBe(true);
    expect(warnings.some((w) => w.includes("hanging-void-plugin"))).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Claiming hooks
  // -----------------------------------------------------------------------

  it("skips a hanging claiming hook handler after timeout", async () => {
    const warnings: string[] = [];

    addTestHook({
      registry,
      pluginId: "hanging-claim-plugin",
      hookName: "inbound_claim",
      handler: (() => new Promise(() => {})) as PluginHookRegistration["handler"],
    });

    const runner = createHookRunner(registry, {
      hookTimeoutMs: 100,
      catchErrors: true,
      logger: {
        debug: () => {},
        warn: (msg) => warnings.push(msg),
        error: (msg) => warnings.push(msg),
      },
    });

    const claimCtx = {
      channelId: "test",
    };
    const promise = runner.runInboundClaim(
      { content: "hello", channel: "test", isGroup: false },
      claimCtx,
    );
    await vi.advanceTimersByTimeAsync(150);

    const result = await promise;

    expect(result).toBeUndefined();
    expect(warnings.some((w) => w.includes("hanging-claim-plugin"))).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Timeout configuration
  // -----------------------------------------------------------------------

  it("uses the default timeout when hookTimeoutMs is not specified", async () => {
    // Handler that resolves in 5 seconds (well under the 10s default)
    addTestHook({
      registry,
      pluginId: "slow-but-ok",
      hookName: "before_agent_start",
      handler: (() =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ prependContext: "slow result" }), 5000);
        })) as PluginHookRegistration["handler"],
    });

    const runner = createHookRunner(registry, { catchErrors: true });
    const promise = runner.runBeforeAgentStart({ prompt: "hello" }, stubCtx);
    await vi.advanceTimersByTimeAsync(5000);

    const result = await promise;
    expect(result?.prependContext).toBe("slow result");
  });

  it("respects hookTimeoutMs: 0 to disable timeout", async () => {
    // Handler that takes a long time but should not be timed out
    addTestHook({
      registry,
      pluginId: "very-slow-plugin",
      hookName: "before_agent_start",
      handler: (() =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ prependContext: "very slow result" }), 30_000);
        })) as PluginHookRegistration["handler"],
    });

    const runner = createHookRunner(registry, { hookTimeoutMs: 0, catchErrors: true });
    const promise = runner.runBeforeAgentStart({ prompt: "hello" }, stubCtx);
    await vi.advanceTimersByTimeAsync(30_000);

    const result = await promise;
    expect(result?.prependContext).toBe("very slow result");
  });

  it("uses custom hookTimeoutMs when specified", async () => {
    const errors: string[] = [];

    addTestHook({
      registry,
      pluginId: "medium-slow-plugin",
      hookName: "before_agent_start",
      handler: (() =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ prependContext: "result" }), 3000);
        })) as PluginHookRegistration["handler"],
    });

    const runner = createHookRunner(registry, {
      hookTimeoutMs: 2000,
      catchErrors: true,
      logger: {
        debug: () => {},
        warn: () => {},
        error: (msg) => errors.push(msg),
      },
    });

    const promise = runner.runBeforeAgentStart({ prompt: "hello" }, stubCtx);
    await vi.advanceTimersByTimeAsync(2500);

    const result = await promise;

    // Should have timed out at 2000ms before the handler resolved at 3000ms
    expect(result).toBeUndefined();
    expect(errors.some((e) => e.includes("medium-slow-plugin"))).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Error propagation when catchErrors is false
  // -----------------------------------------------------------------------

  it("throws timeout error when catchErrors is false", async () => {
    addTestHook({
      registry,
      pluginId: "hanging-throw-plugin",
      hookName: "before_agent_start",
      handler: (() => new Promise(() => {})) as PluginHookRegistration["handler"],
    });

    const runner = createHookRunner(registry, { hookTimeoutMs: 50, catchErrors: false });
    const promise = runner.runBeforeAgentStart({ prompt: "hello" }, stubCtx);

    // Register the rejection handler before advancing timers to avoid
    // unhandled rejection noise.
    const assertion = expect(promise).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });
});
