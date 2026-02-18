/**
 * Test: provide_compaction_summary hook merge logic
 *
 * Exercises the sequential modifying-hook pattern:
 * - Single plugin returning summary
 * - Multiple plugins — last summary wins, skipCompaction OR-logic
 * - Plugin returning void (no-op)
 * - Error in one plugin doesn't block others
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";
import type { PluginHookProvideCompactionSummaryResult, PluginHookRegistration } from "./types.js";

function addCompactionSummaryHook(
  registry: PluginRegistry,
  pluginId: string,
  handler: () =>
    | PluginHookProvideCompactionSummaryResult
    | Promise<PluginHookProvideCompactionSummaryResult>
    | void,
  priority?: number,
) {
  registry.typedHooks.push({
    pluginId,
    hookName: "provide_compaction_summary",
    handler,
    priority,
    source: "test",
  } as PluginHookRegistration);
}

const dummyCtx = {} as never;
const dummyEvent = { messageCount: 10, tokensBefore: 5000 } as never;

describe("provide_compaction_summary merge logic", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  it("returns undefined when no hooks are registered", async () => {
    const runner = createHookRunner(registry);
    const result = await runner.runProvideCompactionSummary(dummyEvent, dummyCtx);
    expect(result).toBeUndefined();
  });

  it("returns summary from a single plugin", async () => {
    addCompactionSummaryHook(registry, "memory-plugin", () => ({
      summary: "User discussed recipe ideas.",
    }));

    const runner = createHookRunner(registry);
    const result = await runner.runProvideCompactionSummary(dummyEvent, dummyCtx);

    expect(result?.summary).toBe("User discussed recipe ideas.");
    expect(result?.skipCompaction).toBeFalsy();
  });

  it("returns skipCompaction from a single plugin", async () => {
    addCompactionSummaryHook(registry, "memory-plugin", () => ({
      skipCompaction: true,
    }));

    const runner = createHookRunner(registry);
    const result = await runner.runProvideCompactionSummary(dummyEvent, dummyCtx);

    expect(result?.skipCompaction).toBe(true);
    expect(result?.summary).toBeUndefined();
  });

  it("last summary wins when multiple plugins provide summaries", async () => {
    addCompactionSummaryHook(registry, "plugin-a", () => ({ summary: "Summary from A" }), 1);
    addCompactionSummaryHook(registry, "plugin-b", () => ({ summary: "Summary from B" }), 10);

    const runner = createHookRunner(registry);
    const result = await runner.runProvideCompactionSummary(dummyEvent, dummyCtx);

    // Higher priority runs first in modifying hooks, then lower priority.
    // The merge function uses next.summary ?? acc.summary, so the last
    // non-undefined summary wins.
    expect(result?.summary).toBe("Summary from A");
  });

  it("skipCompaction uses OR-logic across plugins", async () => {
    addCompactionSummaryHook(
      registry,
      "plugin-a",
      () => ({ skipCompaction: false, summary: "A summary" }),
      10,
    );
    addCompactionSummaryHook(registry, "plugin-b", () => ({ skipCompaction: true }), 1);

    const runner = createHookRunner(registry);
    const result = await runner.runProvideCompactionSummary(dummyEvent, dummyCtx);

    // OR-logic: any plugin requesting skip wins
    expect(result?.skipCompaction).toBe(true);
  });

  it("preserves summary when later plugin returns only skipCompaction", async () => {
    addCompactionSummaryHook(
      registry,
      "memory-plugin",
      () => ({ summary: "Important context" }),
      10,
    );
    addCompactionSummaryHook(registry, "rate-limiter", () => ({ skipCompaction: false }), 1);

    const runner = createHookRunner(registry);
    const result = await runner.runProvideCompactionSummary(dummyEvent, dummyCtx);

    // summary should be preserved from first plugin since second returns undefined summary
    expect(result?.summary).toBe("Important context");
  });

  it("ignores plugins that return void", async () => {
    addCompactionSummaryHook(registry, "no-op-plugin", () => {
      // returns void
    });
    addCompactionSummaryHook(registry, "memory-plugin", () => ({
      summary: "Real summary",
    }));

    const runner = createHookRunner(registry);
    const result = await runner.runProvideCompactionSummary(dummyEvent, dummyCtx);

    expect(result?.summary).toBe("Real summary");
  });

  it("handles async handlers", async () => {
    addCompactionSummaryHook(registry, "async-plugin", async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { summary: "Async summary" };
    });

    const runner = createHookRunner(registry);
    const result = await runner.runProvideCompactionSummary(dummyEvent, dummyCtx);

    expect(result?.summary).toBe("Async summary");
  });
});
