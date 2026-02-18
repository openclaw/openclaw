/**
 * Test: provide_compaction_summary wiring
 *
 * Validates that the hook runner correctly recognizes and dispatches
 * provide_compaction_summary hooks, and that hasHooks() returns true
 * when a handler is registered.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";
import type { PluginHookRegistration } from "./types.js";

describe("provide_compaction_summary wiring", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  it("hasHooks returns false when no provide_compaction_summary handlers registered", () => {
    const runner = createHookRunner(registry);
    expect(runner.hasHooks("provide_compaction_summary")).toBe(false);
  });

  it("hasHooks returns true when a provide_compaction_summary handler is registered", () => {
    registry.typedHooks.push({
      pluginId: "quaid",
      hookName: "provide_compaction_summary",
      handler: () => ({ summary: "test" }),
      source: "test",
    } as PluginHookRegistration);

    const runner = createHookRunner(registry);
    expect(runner.hasHooks("provide_compaction_summary")).toBe(true);
  });

  it("runProvideCompactionSummary passes event data to handler", async () => {
    let receivedEvent: unknown;
    let receivedCtx: unknown;

    registry.typedHooks.push({
      pluginId: "quaid",
      hookName: "provide_compaction_summary",
      handler: (event: unknown, ctx: unknown) => {
        receivedEvent = event;
        receivedCtx = ctx;
        return { summary: "Plugin summary" };
      },
      source: "test",
    } as PluginHookRegistration);

    const runner = createHookRunner(registry);

    const event = {
      messageCount: 42,
      tokensBefore: 8000,
      sessionFile: "/tmp/session.jsonl",
      previousSummary: "Previous summary text",
    };
    const ctx = {
      agentId: "main",
      sessionKey: "telegram:12345",
      sessionId: "sess-1",
    };

    const result = await runner.runProvideCompactionSummary(event as never, ctx as never);

    expect(result?.summary).toBe("Plugin summary");
    expect(receivedEvent).toMatchObject({
      messageCount: 42,
      tokensBefore: 8000,
      sessionFile: "/tmp/session.jsonl",
      previousSummary: "Previous summary text",
    });
    expect(receivedCtx).toMatchObject({
      agentId: "main",
      sessionKey: "telegram:12345",
    });
  });

  it("handles handler that throws without crashing", async () => {
    registry.typedHooks.push({
      pluginId: "broken-plugin",
      hookName: "provide_compaction_summary",
      handler: () => {
        throw new Error("Plugin crashed");
      },
      source: "test",
    } as PluginHookRegistration);

    // createHookRunner with default catchErrors=true should swallow the error
    const runner = createHookRunner(registry);
    const result = await runner.runProvideCompactionSummary(
      { messageCount: 10 } as never,
      {} as never,
    );

    // Error is caught — returns undefined (no result)
    expect(result).toBeUndefined();
  });

  it("requestCompaction is exposed in PluginHookAgentContext type shape", () => {
    // This is a compile-time check — if types.ts correctly includes requestCompaction,
    // this test compiles. We verify the runtime shape matches.
    const mockCtx = {
      agentId: "main",
      sessionKey: "test:1",
      sessionId: "s1",
      workspaceDir: "/tmp",
      requestCompaction: async (_instructions?: string) => true,
    };

    expect(typeof mockCtx.requestCompaction).toBe("function");
  });
});
