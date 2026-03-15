/**
 * Test: runOutboundTransforms
 *
 * Tests the outbound text transform pipeline in the hook runner.
 */
import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";
import type { PluginRegistry } from "./registry.js";

function createRegistryWithTransforms(
  transforms: Array<{ pluginId: string; transform: (text: string) => string }>,
): PluginRegistry {
  const registry = createMockPluginRegistry([]);
  registry.outboundTransforms = transforms;
  return registry;
}

describe("runOutboundTransforms", () => {
  it("returns text unchanged when no transforms are registered", () => {
    const registry = createRegistryWithTransforms([]);
    const runner = createHookRunner(registry);

    expect(runner.runOutboundTransforms("hello world")).toBe("hello world");
  });

  it("applies a single transform", () => {
    const registry = createRegistryWithTransforms([
      { pluginId: "test", transform: (text) => text.replaceAll("[TOKEN]", "Juan") },
    ]);
    const runner = createHookRunner(registry);

    expect(runner.runOutboundTransforms("Hello [TOKEN]")).toBe("Hello Juan");
  });

  it("applies multiple transforms in registration order", () => {
    const registry = createRegistryWithTransforms([
      { pluginId: "first", transform: (text) => text.replaceAll("A", "B") },
      { pluginId: "second", transform: (text) => text.replaceAll("B", "C") },
    ]);
    const runner = createHookRunner(registry);

    // "A" → "B" (first) → "C" (second)
    expect(runner.runOutboundTransforms("A")).toBe("C");
  });

  it("catches errors from a throwing transform and preserves last successful result", () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const registry = createRegistryWithTransforms([
      { pluginId: "good", transform: (text) => text.replaceAll("foo", "bar") },
      {
        pluginId: "bad",
        transform: () => {
          throw new Error("transform broke");
        },
      },
    ]);
    const runner = createHookRunner(registry, { logger, catchErrors: true });

    const result = runner.runOutboundTransforms("foo");
    expect(result).toBe("bar");
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("outbound transform from bad failed"),
    );
  });

  it("throws when catchErrors is false and a transform fails", () => {
    const registry = createRegistryWithTransforms([
      {
        pluginId: "bad",
        transform: () => {
          throw new Error("boom");
        },
      },
    ]);
    const runner = createHookRunner(registry, { catchErrors: false });

    expect(() => runner.runOutboundTransforms("hello")).toThrow(
      "outbound transform from bad failed",
    );
  });

  it("passes through text that does not match any transform patterns", () => {
    const registry = createRegistryWithTransforms([
      { pluginId: "test", transform: (text) => text.replaceAll("[SECRET]", "revealed") },
    ]);
    const runner = createHookRunner(registry);

    expect(runner.runOutboundTransforms("nothing to change")).toBe("nothing to change");
  });
});
