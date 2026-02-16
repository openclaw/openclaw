import { describe, expect, it, vi } from "vitest";
import type { PluginRegistry } from "./registry.js";
import type { PluginHookRegistration } from "./types.js";
import { createHookRunner, type HookRunnerLogger } from "./hooks.js";

function createRegistryWithHooks(hooks: PluginHookRegistration[]): PluginRegistry {
  return {
    plugins: [],
    tools: [],
    hooks: [],
    typedHooks: hooks,
    channels: [],
    providers: [],
    gatewayHandlers: {},
    httpHandlers: [],
    httpRoutes: [],
    cliRegistrars: [],
    services: [],
    commands: [],
    diagnostics: [],
  };
}

const noopLogger: HookRunnerLogger = {
  warn: vi.fn(),
  error: vi.fn(),
};

describe("plugin hook runner policies", () => {
  it("runs hooks in descending priority order", async () => {
    const order: string[] = [];
    const runner = createHookRunner(
      createRegistryWithHooks([
        {
          pluginId: "high",
          hookName: "before_agent_start",
          priority: 10,
          source: "high",
          handler: () => {
            order.push("high");
          },
        },
        {
          pluginId: "low",
          hookName: "before_agent_start",
          priority: 1,
          source: "low",
          handler: () => {
            order.push("low");
          },
        },
      ]),
      { logger: noopLogger },
    );

    await runner.runBeforeAgentStart({ prompt: "x" }, {});
    expect(order).toEqual(["high", "low"]);
  });

  it("skips handlers when condition returns false", async () => {
    const handler = vi.fn();
    const runner = createHookRunner(
      createRegistryWithHooks([
        {
          pluginId: "p1",
          hookName: "agent_end",
          source: "src",
          condition: () => false,
          handler,
        },
      ]),
      { logger: noopLogger },
    );

    await runner.runAgentEnd({ messages: [], success: true }, {});
    expect(handler).not.toHaveBeenCalled();
  });

  it("continues after hook failures in fail-open mode", async () => {
    const after = vi.fn();
    const runner = createHookRunner(
      createRegistryWithHooks([
        {
          pluginId: "bad",
          hookName: "agent_end",
          source: "bad",
          handler: () => {
            throw new Error("boom");
          },
        },
        {
          pluginId: "good",
          hookName: "agent_end",
          source: "good",
          handler: after,
        },
      ]),
      { logger: noopLogger },
    );

    await runner.runAgentEnd({ messages: [], success: true }, {});
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("throws for fail-closed hook failures", async () => {
    const after = vi.fn();
    const runner = createHookRunner(
      createRegistryWithHooks([
        {
          pluginId: "bad",
          hookName: "before_tool_call",
          source: "bad",
          mode: "fail-closed",
          handler: () => {
            throw new Error("nope");
          },
        },
        {
          pluginId: "good",
          hookName: "before_tool_call",
          source: "good",
          handler: after,
        },
      ]),
      { logger: noopLogger, catchErrors: true },
    );

    await expect(
      runner.runBeforeToolCall({ toolName: "echo", params: {} }, { toolName: "echo" }),
    ).rejects.toThrow(/failed/);
    expect(after).not.toHaveBeenCalled();
  });

  it("runs agent_error hooks independently from agent_end hooks", async () => {
    const onEnd = vi.fn();
    const onError = vi.fn();
    const runner = createHookRunner(
      createRegistryWithHooks([
        {
          pluginId: "end",
          hookName: "agent_end",
          source: "end",
          handler: onEnd,
        },
        {
          pluginId: "error",
          hookName: "agent_error",
          source: "error",
          handler: onError,
        },
      ]),
      { logger: noopLogger },
    );

    await runner.runAgentEnd({ messages: [], success: true }, {});
    await runner.runAgentError({ messages: [], success: false, error: "boom" }, {});

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("applies timeoutMs and continues for fail-open hooks", async () => {
    const error = vi.fn();
    const logger: HookRunnerLogger = { warn: vi.fn(), error };
    const runner = createHookRunner(
      createRegistryWithHooks([
        {
          pluginId: "slow",
          hookName: "before_tool_call",
          source: "slow",
          timeoutMs: 5,
          handler: async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
          },
        },
        {
          pluginId: "fast",
          hookName: "before_tool_call",
          source: "fast",
          handler: () => ({ params: { safe: true } }),
        },
      ]),
      { logger, catchErrors: true },
    );

    const out = await runner.runBeforeToolCall(
      { toolName: "echo", params: {} },
      { toolName: "echo" },
    );
    expect(out).toEqual({ params: { safe: true } });
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("applies default timeout when hook timeoutMs is omitted", async () => {
    const error = vi.fn();
    const logger: HookRunnerLogger = { warn: vi.fn(), error };
    const runner = createHookRunner(
      createRegistryWithHooks([
        {
          pluginId: "slow",
          hookName: "before_tool_call",
          source: "slow",
          handler: async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
          },
        },
        {
          pluginId: "fast",
          hookName: "before_tool_call",
          source: "fast",
          handler: () => ({ params: { safe: true } }),
        },
      ]),
      { logger, catchErrors: true, defaultTimeoutMs: 5 },
    );

    const out = await runner.runBeforeToolCall(
      { toolName: "echo", params: {} },
      { toolName: "echo" },
    );
    expect(out).toEqual({ params: { safe: true } });
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("allows message_received hooks to mutate content and cancel", async () => {
    const runner = createHookRunner(
      createRegistryWithHooks([
        {
          pluginId: "rewrite",
          hookName: "message_received",
          source: "rewrite",
          priority: 100,
          handler: () => ({ content: "rewritten" }),
        },
        {
          pluginId: "cancel",
          hookName: "message_received",
          source: "cancel",
          priority: 10,
          handler: () => ({ cancel: true }),
        },
      ]),
      { logger: noopLogger },
    );

    const out = await runner.runMessageReceived(
      { from: "u1", content: "original" },
      { channelId: "slack" },
    );

    expect(out).toEqual({ content: "rewritten", cancel: true });
  });

  it("applies scope filters for channel, agent, and tool", async () => {
    const called = vi.fn();
    const runner = createHookRunner(
      createRegistryWithHooks([
        {
          pluginId: "scoped",
          hookName: "before_tool_call",
          source: "scoped",
          scope: {
            channels: ["slack"],
            agentIds: ["agent-1"],
            toolNames: ["echo"],
          },
          handler: called,
        },
      ]),
      { logger: noopLogger },
    );

    await runner.runBeforeToolCall(
      { toolName: "echo", params: {} },
      { toolName: "echo", agentId: "agent-1" },
    );
    expect(called).not.toHaveBeenCalled();

    await runner.runBeforeToolCall({ toolName: "echo", params: {} }, {
      toolName: "echo",
      agentId: "agent-1",
      channelId: "slack",
    } as never);
    expect(called).toHaveBeenCalledTimes(1);
  });

  it("uses onTimeout override when timeout is reached", async () => {
    const runner = createHookRunner(
      createRegistryWithHooks([
        {
          pluginId: "timeout-open",
          hookName: "before_tool_call",
          source: "timeout-open",
          mode: "fail-closed",
          onTimeout: "fail-open",
          timeoutMs: 1,
          handler: async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
          },
        },
      ]),
      { logger: noopLogger, catchErrors: true },
    );

    await expect(
      runner.runBeforeToolCall({ toolName: "echo", params: {} }, { toolName: "echo" }),
    ).resolves.toBeUndefined();
  });

  it("retries failed handlers according to retry policy", async () => {
    const handler = vi
      .fn<() => { params: Record<string, unknown> }>()
      .mockImplementationOnce(() => {
        throw new Error("attempt-1");
      })
      .mockImplementationOnce(() => {
        throw new Error("attempt-2");
      })
      .mockImplementation(() => ({ params: { ok: true } }));

    const runner = createHookRunner(
      createRegistryWithHooks([
        {
          pluginId: "retry",
          hookName: "before_tool_call",
          source: "retry",
          retry: { count: 2 },
          handler,
        },
      ]),
      { logger: noopLogger },
    );

    const out = await runner.runBeforeToolCall(
      { toolName: "echo", params: {} },
      { toolName: "echo" },
    );

    expect(out).toEqual({ params: { ok: true } });
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it("throws after retry exhaustion when mode is fail-closed", async () => {
    const handler = vi.fn(() => {
      throw new Error("still failing");
    });

    const runner = createHookRunner(
      createRegistryWithHooks([
        {
          pluginId: "retry-fail-closed",
          hookName: "before_tool_call",
          source: "retry-fail-closed",
          mode: "fail-closed",
          retry: { count: 2 },
          handler,
        },
      ]),
      { logger: noopLogger, catchErrors: true },
    );

    await expect(
      runner.runBeforeToolCall({ toolName: "echo", params: {} }, { toolName: "echo" }),
    ).rejects.toThrow(/failed/);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it("enforces maxConcurrency per hook registration", async () => {
    let inFlight = 0;
    let peak = 0;
    const runner = createHookRunner(
      createRegistryWithHooks([
        {
          pluginId: "serial",
          hookName: "agent_end",
          source: "serial",
          maxConcurrency: 1,
          handler: async () => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 20));
            inFlight -= 1;
          },
        },
      ]),
      { logger: noopLogger },
    );

    await Promise.all([
      runner.runAgentEnd({ messages: [], success: true }, {}),
      runner.runAgentEnd({ messages: [], success: true }, {}),
      runner.runAgentEnd({ messages: [], success: true }, {}),
    ]);

    expect(peak).toBe(1);
  });
});
