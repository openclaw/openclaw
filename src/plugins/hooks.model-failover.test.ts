/**
 * Tests for model_failover and model_failure_terminal plugin hooks.
 * Covers: hook runner wiring, fire-and-forget semantics, event payload shape.
 */

import { describe, expect, it, vi } from "vitest";
import type {
  PluginHookModelFailoverEvent,
  PluginHookModelFailureTerminalEvent,
} from "./hook-types.js";
import { createHookRunnerWithRegistry } from "./hooks.test-helpers.js";

const BASE_AGENT_CTX = {
  runId: "run-1",
  agentId: "main",
  sessionId: "session-1",
  sessionKey: "agent:test:direct:123",
};

describe("model_failover hook", () => {
  it("invokes registered model_failover handlers with the full event payload", async () => {
    const handler = vi.fn();
    const { runner } = createHookRunnerWithRegistry([{ hookName: "model_failover", handler }]);

    const event: PluginHookModelFailoverEvent = {
      runId: "run-1",
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:test:direct:123",
      provider: "openai-codex",
      model: "gpt-5.4",
      sourceProvider: "openai-codex",
      sourceModel: "gpt-5.4",
      stage: "prompt",
      decision: "fallback_model",
      failoverReason: "rate_limit",
      profileFailureReason: null,
      fallbackConfigured: true,
      timedOut: false,
      aborted: false,
      status: 429,
    };

    await runner.runModelFailover(event, BASE_AGENT_CTX);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        provider: "openai-codex",
        model: "gpt-5.4",
        stage: "prompt",
        decision: "fallback_model",
        failoverReason: "rate_limit",
        fallbackConfigured: true,
        status: 429,
      }),
      expect.objectContaining({ runId: "run-1", sessionId: "session-1" }),
    );
  });

  it("fires all handlers in parallel when multiple model_failover hooks are registered", async () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "model_failover", handler: handler1, pluginId: "plugin-a" },
      { hookName: "model_failover", handler: handler2, pluginId: "plugin-b" },
    ]);

    const event: PluginHookModelFailoverEvent = {
      provider: "anthropic",
      model: "claude-sonnet",
      stage: "assistant",
      decision: "rotate_profile",
      fallbackConfigured: false,
    };

    await runner.runModelFailover(event, BASE_AGENT_CTX);

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it("does not call handler when no model_failover hooks are registered", async () => {
    const handler = vi.fn();
    // Register a different hook name so the registry has entries but not for model_failover
    const { runner } = createHookRunnerWithRegistry([{ hookName: "agent_end", handler }]);

    const event: PluginHookModelFailoverEvent = {
      provider: "openai",
      model: "gpt-4",
      stage: "prompt",
      decision: "surface_error",
      fallbackConfigured: false,
    };

    await runner.runModelFailover(event, BASE_AGENT_CTX);

    expect(handler).not.toHaveBeenCalled();
  });

  it("continues execution when a model_failover handler throws (fail-open)", async () => {
    const failingHandler = vi.fn().mockRejectedValue(new Error("plugin exploded"));
    const goodHandler = vi.fn();
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "model_failover", handler: failingHandler, pluginId: "bad-plugin" },
      { hookName: "model_failover", handler: goodHandler, pluginId: "good-plugin" },
    ]);

    const event: PluginHookModelFailoverEvent = {
      provider: "openai",
      model: "gpt-4",
      stage: "prompt",
      decision: "fallback_model",
      fallbackConfigured: true,
    };

    // Should not throw despite the failing handler
    await expect(runner.runModelFailover(event, BASE_AGENT_CTX)).resolves.toBeUndefined();
    expect(goodHandler).toHaveBeenCalledTimes(1);
  });

  it("includes hasHooks('model_failover') = true when a handler is registered", () => {
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "model_failover", handler: vi.fn() },
    ]);
    expect(runner.hasHooks("model_failover")).toBe(true);
  });

  it("includes hasHooks('model_failover') = false when no handler is registered", () => {
    const { runner } = createHookRunnerWithRegistry([]);
    expect(runner.hasHooks("model_failover")).toBe(false);
  });
});

describe("model_failure_terminal hook", () => {
  it("invokes registered model_failure_terminal handlers with a full event payload", async () => {
    const handler = vi.fn();
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "model_failure_terminal", handler },
    ]);

    const event: PluginHookModelFailureTerminalEvent = {
      runId: "run-1",
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:test:direct:123",
      finalMessage:
        "All 2 models failed (2): openai-codex/gpt-5.4 (rate_limit) | anthropic/claude-sonnet (overloaded)",
      kind: "all_models_failed",
      attempts: [
        { provider: "openai-codex", model: "gpt-5.4", reason: "rate_limit" },
        { provider: "anthropic", model: "claude-sonnet", reason: "overloaded" },
      ],
    };

    await runner.runModelFailureTerminal(event, BASE_AGENT_CTX);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        finalMessage: expect.stringContaining("All 2 models failed"),
        kind: "all_models_failed",
        attempts: [
          { provider: "openai-codex", model: "gpt-5.4", reason: "rate_limit" },
          { provider: "anthropic", model: "claude-sonnet", reason: "overloaded" },
        ],
      }),
      expect.objectContaining({ runId: "run-1" }),
    );
  });

  it("supports kind='run_failed_before_reply' without attempts", async () => {
    const handler = vi.fn();
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "model_failure_terminal", handler },
    ]);

    const event: PluginHookModelFailureTerminalEvent = {
      runId: "run-2",
      finalMessage: "OAuth token refresh failed",
      kind: "run_failed_before_reply",
    };

    await runner.runModelFailureTerminal(event, BASE_AGENT_CTX);

    const [receivedEvent] = handler.mock.calls[0]!;
    expect(receivedEvent).toMatchObject({
      kind: "run_failed_before_reply",
      finalMessage: "OAuth token refresh failed",
    });
    // attempts should be absent or undefined when not provided
    expect(receivedEvent.attempts).toBeUndefined();
  });

  it("continues execution when a model_failure_terminal handler throws (fail-open)", async () => {
    const failingHandler = vi.fn().mockRejectedValue(new Error("terminal handler crashed"));
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "model_failure_terminal", handler: failingHandler },
    ]);

    const event: PluginHookModelFailureTerminalEvent = {
      finalMessage: "something broke",
      kind: "run_failed_before_reply",
    };

    await expect(runner.runModelFailureTerminal(event, BASE_AGENT_CTX)).resolves.toBeUndefined();
  });

  it("includes hasHooks('model_failure_terminal') = true when a handler is registered", () => {
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "model_failure_terminal", handler: vi.fn() },
    ]);
    expect(runner.hasHooks("model_failure_terminal")).toBe(true);
  });
});

describe("model_failover hook name registration", () => {
  it("isPluginHookName recognizes model_failover and model_failure_terminal", async () => {
    const { isPluginHookName } = await import("./hook-types.js");
    expect(isPluginHookName("model_failover")).toBe(true);
    expect(isPluginHookName("model_failure_terminal")).toBe(true);
  });

  it("PLUGIN_HOOK_NAMES includes model_failover and model_failure_terminal", async () => {
    const { PLUGIN_HOOK_NAMES } = await import("./hook-types.js");
    expect(PLUGIN_HOOK_NAMES).toContain("model_failover");
    expect(PLUGIN_HOOK_NAMES).toContain("model_failure_terminal");
  });
});
