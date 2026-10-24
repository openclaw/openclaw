import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";
import {
  addAllowlistUserEntriesFromConfigEntry,
  buildAllowlistResolutionSummary,
  patchAllowlistUsersInConfigEntries,
  summarizeMapping,
} from "./resolve-utils.js";

describe("buildAllowlistResolutionSummary", () => {
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

  it("supports custom resolved formatting", () => {
    const result = buildAllowlistResolutionSummary(
      [{ input: "a", resolved: true, id: "1", note: "x" }],
      { formatResolved: (entry) => `${entry.input}→${entry.id}${entry.note ? " (note)" : ""}` },
    );
    expect(result.mapping).toEqual(["a→1 (note)"]);
  });

  it("supports custom unresolved formatting", () => {
    const result = buildAllowlistResolutionSummary(
      [{ input: "a", resolved: false, note: "missing" }],
      { formatUnresolved: (entry) => `${entry.input}${entry.note ? " (missing)" : ""}` },
    );
    expect(result.unresolved).toEqual(["a (missing)"]);
  });
});

describe("addAllowlistUserEntriesFromConfigEntry", () => {
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
});

it("patchAllowlistUsersInConfigEntries canonicalizes nested users", () => {
  const patched = patchAllowlistUsersInConfigEntries({
    entries: { alpha: { users: ["Alice", "111", "Bob"] }, beta: { users: ["*"] } },
    resolvedMap: new Map([
      ["Alice", { input: "Alice", resolved: true, id: "111" }],
      ["Bob", { input: "Bob", resolved: false }],
    ]),
    strategy: "canonicalize",
  });
  expect(patched).toEqual({ alpha: { users: ["111", "Bob"] }, beta: { users: ["*"] } });
});

it("patchAllowlistUsersInConfigEntries keeps original users before resolved IDs by default", () => {
  const patched = patchAllowlistUsersInConfigEntries({
    entries: { alpha: { users: [" Alice ", "Bob"], enabled: true }, beta: { topic: "room" } },
    resolvedMap: new Map([
      ["Alice", { input: "Alice", resolved: true, id: "111" }],
      ["Bob", { input: "Bob", resolved: false }],
    ]),
  });
  expect(patched).toEqual({
    alpha: { users: ["Alice", "Bob", "111"], enabled: true },
    beta: { topic: "room" },
  });
});

describe("summarizeMapping", () => {
  it("logs sampled resolved and unresolved entries", () => {
    const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    summarizeMapping("demo allowlist", ["a", "b", "c", "d", "e", "f", "g"], ["x", "y"], runtime);
    expect(runtime.log).toHaveBeenNthCalledWith(
      1,
      "demo allowlist resolved: a, b, c, d, e, f (+1)",
    );
    expect(runtime.log).toHaveBeenNthCalledWith(2, "demo allowlist unresolved: x, y");
  });

  it("skips logging when both lists are empty", () => {
    const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    summarizeMapping("demo allowlist", [], [], runtime);
    expect(runtime.log).not.toHaveBeenCalled();
  });
});
