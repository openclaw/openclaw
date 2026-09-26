/** Tests hook lifecycle gates for startup, activation, cleanup, and retired registries. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GlobalHookRunnerRegistry } from "./hook-registry.types.js";
import type { PluginHookRegistration, PluginHookAgentContext } from "./hook-types.js";
import { createHookRunner } from "./hooks.js";

function makeRegistry(hooks: PluginHookRegistration[] = []): GlobalHookRunnerRegistry {
  return {
    hooks: [],
    typedHooks: hooks,
    plugins: [],
  };
}

function makeGateRunner(
  hooks: Pick<
    PluginHookRegistration<"before_agent_run">,
    "pluginId" | "handler" | "priority"
  >[] = [],
) {
  return createHookRunner(
    makeRegistry(
      hooks.map<PluginHookRegistration<"before_agent_run">>((hook) => ({
        ...hook,
        hookName: "before_agent_run",
        source: "test",
      })),
    ),
  );
}

const ctx: PluginHookAgentContext = {
  runId: "run-1",
  agentId: "agent-1",
  sessionKey: "session-1",
  sessionId: "sid-1",
};

describe("before_agent_run hook", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns undefined when no handlers registered", async () => {
    const runner = makeGateRunner();
    const result = await runner.runBeforeAgentRun({ prompt: "hello", messages: [] }, ctx);
    expect(result).toBeUndefined();
  });

  it("returns pass when handler returns pass", async () => {
    const runner = makeGateRunner([
      {
        pluginId: "test",
        handler: async () => ({ outcome: "pass" as const }),
      },
    ]);
    const result = await runner.runBeforeAgentRun({ prompt: "hello", messages: [] }, ctx);
    expect(result?.decision).toEqual({ outcome: "pass" });
    expect(result?.pluginId).toBe("test");
  });

  it("returns block when handler returns block (with `message`)", async () => {
    const runner = makeGateRunner([
      {
        pluginId: "test",
        handler: async () => ({
          outcome: "block" as const,
          reason: "unsafe content",
          message: "I can't process that.",
          category: "violence",
        }),
      },
    ]);
    const result = await runner.runBeforeAgentRun({ prompt: "bad stuff", messages: [] }, ctx);
    expect(result?.decision.outcome).toBe("block");
    if (result?.decision.outcome === "block") {
      expect(result.decision.reason).toBe("unsafe content");
      expect(result.decision.message).toBe("I can't process that.");
    }
  });

  it("blocks when one of multiple handlers passes and a later handler blocks", async () => {
    const calls: string[] = [];
    const passHandler = vi.fn(async () => {
      calls.push("pass-plugin");
      return { outcome: "pass" as const };
    });
    const blockHandler = vi.fn(async () => {
      calls.push("block-plugin");
      return {
        outcome: "block" as const,
        reason: "blocked",
      };
    });
    const runner = makeGateRunner([
      {
        pluginId: "pass-plugin",
        handler: passHandler,
        priority: 10,
      },
      {
        pluginId: "block-plugin",
        handler: blockHandler,
        priority: 5,
      },
    ]);
    const result = await runner.runBeforeAgentRun({ prompt: "test", messages: [] }, ctx);

    expect(result?.decision.outcome).toBe("block");
    expect(result?.pluginId).toBe("block-plugin");
    expect(passHandler).toHaveBeenCalledTimes(1);
    expect(blockHandler).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["pass-plugin", "block-plugin"]);
  });

  it("short-circuits when the first of multiple handlers blocks", async () => {
    const blockHandler = vi.fn(async () => ({
      outcome: "block" as const,
      reason: "blocked",
    }));
    const passHandler = vi.fn(async () => ({ outcome: "pass" as const }));
    const runner = makeGateRunner([
      {
        pluginId: "block-plugin",
        handler: blockHandler,
        priority: 10,
      },
      {
        pluginId: "pass-plugin",
        handler: passHandler,
        priority: 5,
      },
    ]);
    const result = await runner.runBeforeAgentRun({ prompt: "test", messages: [] }, ctx);

    expect(result?.decision.outcome).toBe("block");
    expect(result?.pluginId).toBe("block-plugin");
    expect(blockHandler).toHaveBeenCalledTimes(1);
    expect(passHandler).not.toHaveBeenCalled();
  });

  it("treats void handler returns as pass (no effect)", async () => {
    const runner = makeGateRunner([
      {
        pluginId: "void-plugin",
        handler: async () => undefined,
      },
    ]);
    const result = await runner.runBeforeAgentRun({ prompt: "test", messages: [] }, ctx);
    expect(result).toBeUndefined();
  });

  it("fails closed on null handler results", async () => {
    const runner = makeGateRunner([
      {
        pluginId: "null-plugin",
        handler: async () => null as never,
      },
    ]);
    const result = await runner.runBeforeAgentRun({ prompt: "test", messages: [] }, ctx);
    expect(result).toEqual({
      decision: {
        outcome: "block",
        reason: "before_agent_run returned an invalid decision",
      },
      pluginId: "null-plugin",
    });
  });

  it("fails closed when handlers throw", async () => {
    const runner = makeGateRunner([
      {
        pluginId: "throwing-plugin",
        handler: async () => {
          throw new Error("policy unavailable");
        },
      },
    ]);
    await expect(runner.runBeforeAgentRun({ prompt: "test", messages: [] }, ctx)).rejects.toThrow(
      "before_agent_run handler from throwing-plugin failed: policy unavailable",
    );
  });

  it("fails closed when handlers exceed the default timeout", async () => {
    vi.useFakeTimers();
    const runner = makeGateRunner([
      {
        pluginId: "hanging-plugin",
        handler: async () => await new Promise<never>(() => {}),
      },
    ]);
    const resultPromise = runner.runBeforeAgentRun({ prompt: "test", messages: [] }, ctx);
    const rejection = expect(resultPromise).rejects.toThrow(
      "before_agent_run handler from hanging-plugin failed: timed out after 15000ms",
    );

    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
  });

  it("receives the correct event payload", async () => {
    let receivedEvent: unknown;
    const runner = makeGateRunner([
      {
        pluginId: "test",
        handler: async (event: unknown) => {
          receivedEvent = event;
          return { outcome: "pass" as const };
        },
      },
    ]);
    await runner.runBeforeAgentRun(
      {
        prompt: "hello world",
        messages: [{ role: "user", content: "hello" }],
        channelId: "discord",
        senderId: "user-123",
      },
      ctx,
    );
    const event = receivedEvent as Record<string, unknown>;
    expect(event.prompt).toBe("hello world");
    expect(event.channelId).toBe("discord");
    expect(event.senderId).toBe("user-123");
  });
});

describe("before_agent_run invalid ask outcome", () => {
  it("short-circuits unsupported ask decisions", async () => {
    let secondHandlerCalled = false;
    const runner = makeGateRunner([
      {
        pluginId: "plugin-a",
        handler: async () =>
          ({
            outcome: "ask" as const,
            reason: "check",
            title: "Check",
            description: "Check this.",
          }) as never,
        priority: 10,
      },
      {
        pluginId: "plugin-b",
        handler: async () => {
          secondHandlerCalled = true;
          return { outcome: "pass" as const };
        },
        priority: 5,
      },
    ]);
    const result = await runner.runBeforeAgentRun({ prompt: "test", messages: [] }, ctx);
    expect(result?.decision.outcome).toBe("block");
    expect(result?.pluginId).toBe("plugin-a");
    expect(secondHandlerCalled).toBe(false);
  });
});

describe("before_tool_call channelId forwarding", () => {
  it("passes channelId through to before_tool_call handlers", async () => {
    let receivedCtx: unknown;
    const registry = makeRegistry([
      {
        pluginId: "test",
        hookName: "before_tool_call",
        handler: async (eventValue: unknown, ctxLocal: unknown) => {
          receivedCtx = ctxLocal;
          return undefined;
        },
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry);
    await runner.runBeforeToolCall(
      { toolName: "exec", params: {} },
      { toolName: "exec", channelId: "discord", sessionKey: "s1" },
    );
    expect((receivedCtx as { channelId?: string }).channelId).toBe("discord");
  });
});
