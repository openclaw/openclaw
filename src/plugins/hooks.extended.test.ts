/**
 * Unit tests for before_response_emit hook merge semantics.
 *
 * See hooks.context-loop.test.ts for context_assembled and loop_iteration tests.
 */
import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import type { PluginRegistry } from "./registry.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforeResponseEmitEvent,
  PluginHookRegistration,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRegistry(hooks: PluginHookRegistration[]): PluginRegistry {
  return {
    typedHooks: hooks,
    plugins: [],
    tools: [],
    commands: [],
    configOverrides: [],
    sessionFinalizers: [],
    registeredProviders: [],
  } as unknown as PluginRegistry;
}

const agentCtx: PluginHookAgentContext = {
  agentId: "test-agent",
  sessionKey: "test-session",
};

// ---------------------------------------------------------------------------
// before_response_emit (modifying, sequential)
// ---------------------------------------------------------------------------

describe("before_response_emit hook", () => {
  const baseEvent: PluginHookBeforeResponseEmitEvent = {
    content: "Hello world",
    allContent: ["Step 1", "Step 2", "Hello world"],
    channel: "test",
    messageCount: 3,
  };

  it("uses first-writer-wins for content", async () => {
    const hooks: PluginHookRegistration[] = [
      {
        hookName: "before_response_emit",
        pluginId: "a",
        source: "test",
        priority: 100,
        handler: vi.fn().mockReturnValue({ content: "Modified A" }),
      },
      {
        hookName: "before_response_emit",
        pluginId: "b",
        source: "test",
        priority: 50,
        handler: vi.fn().mockReturnValue({ content: "Modified B" }),
      },
    ];
    const runner = createHookRunner(makeRegistry(hooks));
    const result = await runner.runBeforeResponseEmit(baseEvent, agentCtx);
    expect(result?.content).toBe("Modified A");
  });

  it("allContent takes precedence over content when first", async () => {
    const hooks: PluginHookRegistration[] = [
      {
        hookName: "before_response_emit",
        pluginId: "a",
        source: "test",
        priority: 100,
        handler: vi.fn().mockReturnValue({ allContent: ["X", "Y", "Z"] }),
      },
      {
        hookName: "before_response_emit",
        pluginId: "b",
        source: "test",
        priority: 50,
        handler: vi.fn().mockReturnValue({ content: "Modified B" }),
      },
    ];
    const runner = createHookRunner(makeRegistry(hooks));
    const result = await runner.runBeforeResponseEmit(baseEvent, agentCtx);
    expect(result?.allContent).toEqual(["X", "Y", "Z"]);
    expect(result?.content).toBeUndefined();
  });

  it("merges block from multiple handlers (one-way latch)", async () => {
    const hooks: PluginHookRegistration[] = [
      {
        hookName: "before_response_emit",
        pluginId: "a",
        source: "test",
        priority: 100,
        handler: vi.fn().mockReturnValue({ block: false }),
      },
      {
        hookName: "before_response_emit",
        pluginId: "b",
        source: "test",
        priority: 50,
        handler: vi.fn().mockReturnValue({ block: true, blockReason: "policy" }),
      },
    ];
    const runner = createHookRunner(makeRegistry(hooks));
    const result = await runner.runBeforeResponseEmit(baseEvent, agentCtx);
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toBe("policy");
  });

  it("returns undefined when no handlers registered", async () => {
    const runner = createHookRunner(makeRegistry([]));
    const result = await runner.runBeforeResponseEmit(baseEvent, agentCtx);
    expect(result).toBeUndefined();
  });

  it("first-writer-wins: higher-priority content blocks lower-priority allContent", async () => {
    // Handler A (priority 50, runs first) sets content. Handler B (priority 10, runs second)
    // sets allContent. The merge treats content and allContent as mutually exclusive:
    // whichever field is set first blocks the other from being set by later handlers.
    const hooks = [
      {
        hookName: "before_response_emit" as const,
        pluginId: "a",
        source: "test" as const,
        priority: 50,
        handler: vi.fn().mockReturnValue({ content: "redacted by A" }),
      },
      {
        hookName: "before_response_emit" as const,
        pluginId: "b",
        source: "test" as const,
        priority: 10,
        handler: vi.fn().mockReturnValue({ allContent: ["replaced by B"] }),
      },
    ];
    const runner = createHookRunner(makeRegistry(hooks));
    const result = await runner.runBeforeResponseEmit(baseEvent, agentCtx);
    // A ran first and set content — B's allContent is blocked (mutual exclusion).
    expect(result?.content).toBe("redacted by A");
    expect(result?.allContent).toBeUndefined();
  });

  it("first-writer-wins: higher-priority allContent is not overridden by lower-priority allContent", async () => {
    // Higher priority number = runs first = wins first-writer-wins
    const hooks = [
      {
        hookName: "before_response_emit" as const,
        pluginId: "a",
        source: "test" as const,
        priority: 50,
        handler: vi.fn().mockReturnValue({ allContent: ["first"] }),
      },
      {
        hookName: "before_response_emit" as const,
        pluginId: "b",
        source: "test" as const,
        priority: 10,
        handler: vi.fn().mockReturnValue({ allContent: ["second"] }),
      },
    ];
    const runner = createHookRunner(makeRegistry(hooks));
    const result = await runner.runBeforeResponseEmit(baseEvent, agentCtx);
    expect(result?.allContent).toEqual(["first"]);
  });
});
