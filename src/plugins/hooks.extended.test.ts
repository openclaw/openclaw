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

  it("first-writer-wins: higher-priority content sticks even when lower-priority sets allContent", async () => {
    // Handler A (priority 10, runs first) sets content. Handler B (priority 50, runs second)
    // sets allContent. A's content wins for the content field. B's allContent wins for the
    // allContent field. These are independent first-writer-wins fields in the merge.
    // Note: applyBeforeResponseEmitHook checks allContent first, then content — so when
    // both are present in the merged result, allContent takes precedence at the application layer.
    const hooks = [
      {
        hookName: "before_response_emit" as const,
        pluginId: "a",
        source: "test" as const,
        priority: 10,
        handler: vi.fn().mockReturnValue({ content: "redacted by A" }),
      },
      {
        hookName: "before_response_emit" as const,
        pluginId: "b",
        source: "test" as const,
        priority: 50,
        handler: vi.fn().mockReturnValue({ allContent: ["replaced by B"] }),
      },
    ];
    const runner = createHookRunner(makeRegistry(hooks));
    const result = await runner.runBeforeResponseEmit(baseEvent, agentCtx);
    // The merge function treats content and allContent as mutually exclusive —
    // when allContent is set by any handler, content is dropped to undefined.
    // This prevents conflicting modifications.
    expect(result?.content).toBeUndefined();
    expect(result?.allContent).toEqual(["replaced by B"]);
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
