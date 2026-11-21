import { expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";
import {
  addAllowlistUserEntriesFromConfigEntry,
  buildAllowlistResolutionSummary,
  patchAllowlistUsersInConfigEntries,
  summarizeMapping,
} from "./resolve-utils.js";

const resolvedMap = new Map([
  ["Alice", { input: "Alice", resolved: true, id: "111" }],
  ["Bob", { input: "Bob", resolved: false }],
]);
const makeRuntime = (): RuntimeEnv => ({ log: vi.fn(), error: vi.fn(), exit: vi.fn() });

it("returns mapping, additions, and unresolved (including missing ids)", () => {
  const result = buildAllowlistResolutionSummary([
    { input: "a", resolved: true, id: "1" },
    { input: "b", resolved: false },
    { input: "c", resolved: true },
  ]);
  expect(result).toMatchObject({ mapping: ["a→1"], additions: ["1"], unresolved: ["b", "c"] });
});

it("omits identity lookups from the logged mapping but keeps their additions", () => {
  const result = buildAllowlistResolutionSummary([
    { input: "42", resolved: true, id: "42" },
    { input: "alice", resolved: true, id: "1" },
  ]);
  expect(result).toMatchObject({ mapping: ["alice→1"], additions: ["42", "1"] });
});

it.each([true, false])("supports custom formatting with resolved=%s", (resolved) => {
  const result = buildAllowlistResolutionSummary([{ input: "a", resolved, id: "1", note: "x" }], {
    formatResolved: (entry) => `${entry.input}→${entry.id} (${entry.note})`,
    formatUnresolved: (entry) => `${entry.input} (${entry.note})`,
  });
  expect(resolved ? result.mapping : result.unresolved).toEqual([resolved ? "a→1 (x)" : "a (x)"]);
});

it("adds trimmed users and skips '*' and blanks", () => {
  const target = new Set<string>();
  addAllowlistUserEntriesFromConfigEntry(target, { users: ["  a  ", "*", "", "b"] });
  expect(Array.from(target).toSorted()).toEqual(["a", "b"]);
});

it("ignores non-objects", () => {
  const target = new Set<string>(["a"]);
  addAllowlistUserEntriesFromConfigEntry(target, null);
  expect(Array.from(target)).toEqual(["a"]);
});

it.each([
  { strategy: "canonicalize" as const, users: ["Alice", "111", "Bob"], expected: ["111", "Bob"] },
  { strategy: undefined, users: [" Alice ", "Bob"], expected: ["Alice", "Bob", "111"] },
])("patches nested users with strategy=$strategy", ({ strategy, users, expected }) => {
  const patched = patchAllowlistUsersInConfigEntries({
    entries: { alpha: { users, enabled: true }, beta: { users: ["*"] }, gamma: { topic: "room" } },
    resolvedMap,
    strategy,
  });
  expect(patched).toEqual({
    alpha: { users: expected, enabled: true },
    beta: { users: ["*"] },
    gamma: { topic: "room" },
  });
});

it("logs sampled resolved and unresolved entries", () => {
  const runtime = makeRuntime();
  summarizeMapping("demo allowlist", ["a", "b", "c", "d", "e", "f", "g"], ["x", "y"], runtime);
  expect(runtime.log).toHaveBeenNthCalledWith(1, "demo allowlist resolved: a, b, c, d, e, f (+1)");
  expect(runtime.log).toHaveBeenNthCalledWith(2, "demo allowlist unresolved: x, y");
});

it("skips logging when both lists are empty", () => {
  const runtime = makeRuntime();
  summarizeMapping("demo allowlist", [], [], runtime);
  expect(runtime.log).not.toHaveBeenCalled();
});
