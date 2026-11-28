import { describe, expect, it } from "vitest";
import {
  createToolUsageCatalogResolver,
  decayToolUsage,
  mergeToolUsage,
  successfulToolUsage,
  TOOL_USAGE_HALF_LIFE_MS,
} from "./tool-usage.js";

describe("tool usage scoring", () => {
  it("decays to the later call and merges independently of flush order", () => {
    const a = { toolId: "openclaw:sample:lookup", score: 4, updatedAt: 100 };
    const b = { toolId: a.toolId, score: 1, updatedAt: 100 + TOOL_USAGE_HALF_LIFE_MS };
    expect(decayToolUsage(a, b.updatedAt)).toBe(2);
    expect(mergeToolUsage(a, b)).toEqual({ ...b, score: 3 });
    expect(mergeToolUsage(b, a)).toEqual({ ...b, score: 3 });
    expect(decayToolUsage(mergeToolUsage(a, b), b.updatedAt + TOOL_USAGE_HALF_LIFE_MS)).toBe(1.5);
    expect(decayToolUsage(a, 0)).toBe(4);
  });

  it.each([
    "running",
    "started",
    "queued",
    "pending",
    "approval-pending",
    "waiting",
    "skipped",
    "cancelled",
    "error",
  ])("does not count a %s result as an executed success", (status) => {
    expect(successfulToolUsage({ isError: false, result: { details: { status } } })).toBe(false);
  });

  it("requires actual execution outside incognito and accepts terminal success", () => {
    expect(successfulToolUsage({ isError: false, executionStarted: false })).toBe(false);
    expect(successfulToolUsage({ isError: false, incognito: true })).toBe(false);
    expect(successfulToolUsage({ isError: true })).toBe(false);
    expect(
      successfulToolUsage({ isError: false, result: { details: { status: "completed" } } }),
    ).toBe(true);
  });
});

it("rejects ambiguous historical names but resolves exact OpenClaw and MCP ids", () => {
  const resolve = createToolUsageCatalogResolver([
    { id: "openclaw:notes:lookup", name: "lookup" },
    { id: "mcp:bundle:lookup", name: "lookup" },
  ]);
  const evidence = { details: { mcpServer: "bundle" } };
  expect(resolve("lookup", evidence)).toBeUndefined();
  expect(resolve("mcp:bundle:lookup")).toBe("mcp:bundle:lookup");
  expect(resolve("openclaw:notes:lookup")).toBe("openclaw:notes:lookup");
  // Exact MCP ids name their server; bare names need matching server evidence.
  expect(resolve("mcp:granola:granola__list")).toBe("mcp:granola:granola__list");
  expect(resolve("granola__list", { details: { mcpServer: "granola" } })).toBe(
    "mcp:granola:granola__list",
  );
  expect(resolve("granola__list", { details: { mcpServer: "linear" } })).toBeUndefined();
  expect(resolve("granola__list")).toBeUndefined();
  expect(resolve("openclaw:other:lookup")).toBeUndefined();
});
