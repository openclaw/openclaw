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
});
