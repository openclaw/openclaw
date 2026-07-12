// Hook handler diagnostics tests cover per-plugin timing emission.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import {
  buildHookHandlerRef,
  invokeHookHandlerWithDiagnostics,
  resolveHookHandlerDiagnosticIdentity,
} from "./hook-handler-diagnostics.js";

describe("hook-handler-diagnostics", () => {
  afterEach(() => {
    resetDiagnosticEventsForTest();
  });

  it("builds handlerRef with plugin, hook, and function name", () => {
    expect(
      buildHookHandlerRef({
        pluginId: "active-memory",
        hookName: "before_prompt_build",
        handlerName: "buildPrompt",
      }),
    ).toBe("hook:active-memory:before_prompt_build@buildPrompt");
  });

  it("falls back to source basename when handler is anonymous", () => {
    const anonymousHandler = (() => {
      const handlers = [() => undefined];
      return handlers[0]!;
    })();
    const identity = resolveHookHandlerDiagnosticIdentity({
      pluginId: "session-memory",
      hookName: "before_agent_start",
      handler: anonymousHandler,
      source: "/Users/demo/.openclaw/extensions/session-memory/index.ts",
    });
    expect(identity.handlerName).toBeUndefined();
    expect(identity.handlerSource).toBe("index.ts");
    expect(identity.handlerRef).toBe("hook:session-memory:before_agent_start#index.ts");
  });

  it("emits hook.handler.completed with plugin id and duration", async () => {
    const events: Array<{
      type: string;
      pluginId?: string;
      hookName?: string;
      handlerRef?: string;
      durationMs?: number;
    }> = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      events.push(event);
    });

    async function beforeToolCallHandler() {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await invokeHookHandlerWithDiagnostics({
      hook: {
        pluginId: "policy",
        hookName: "before_tool_call",
        handler: beforeToolCallHandler,
        source: "/tmp/extensions/policy/index.ts",
      },
      event: { runId: "run-1" },
      ctx: { sessionKey: "agent:main:main" },
      invoke: beforeToolCallHandler,
    });

    await waitForDiagnosticEventsDrained();
    unsubscribe();
    expect(events).toEqual([
      expect.objectContaining({
        type: "hook.handler.completed",
        pluginId: "policy",
        hookName: "before_tool_call",
        handlerName: "beforeToolCallHandler",
        handlerSource: "index.ts",
        handlerRef: "hook:policy:before_tool_call@beforeToolCallHandler",
        runId: "run-1",
        sessionKey: "agent:main:main",
        outcome: "completed",
      }),
    ]);
    expect(events[0]?.durationMs).toBeGreaterThan(0);
  });

  it("records error outcome when handler throws", async () => {
    const events: Array<{ outcome?: string }> = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      events.push(event);
    });

    function failingHandler() {
      throw new Error("boom");
    }

    await expect(
      invokeHookHandlerWithDiagnostics({
        hook: {
          pluginId: "demo",
          hookName: "after_tool_call",
          handler: failingHandler,
        },
        event: {},
        ctx: {},
        invoke: failingHandler,
      }),
    ).rejects.toThrow("boom");

    await waitForDiagnosticEventsDrained();
    unsubscribe();
    expect(events[0]?.outcome).toBe("error");
  });

  it("skips emission when diagnostics are disabled", async () => {
    setDiagnosticsEnabledForProcess(false);
    const listener = vi.fn();
    const unsubscribe = onInternalDiagnosticEvent(listener);

    await invokeHookHandlerWithDiagnostics({
      hook: {
        pluginId: "demo",
        hookName: "agent_end",
        handler: () => undefined,
      },
      event: {},
      ctx: {},
      invoke: () => undefined,
    });

    await waitForDiagnosticEventsDrained();
    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
  });
});
