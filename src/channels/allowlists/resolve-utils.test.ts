import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";
import {
  addAllowlistUserEntriesFromConfigEntry,
  buildAllowlistResolutionSummary,
  canonicalizeAllowlistWithResolvedIds,
  logResolutionSummary,
  patchAllowlistUsersInConfigEntries,
} from "./resolve-utils.js";

describe("buildAllowlistResolutionSummary", () => {
  it("returns mapping, additions, and unresolved (including missing ids)", () => {
    const resolvedUsers = [
      { input: "a", resolved: true, id: "1" },
      { input: "b", resolved: false },
      { input: "c", resolved: true },
    ];
    const result = buildAllowlistResolutionSummary(resolvedUsers);
    expect(result.mapping).toEqual(["a→1"]);
    expect(result.additions).toEqual(["1"]);
    expect(result.unresolved).toEqual(["b", "c"]);
  });

  it("supports custom resolved formatting", () => {
    const resolvedUsers = [{ input: "a", resolved: true, id: "1", note: "x" }];
    const result = buildAllowlistResolutionSummary(resolvedUsers, {
      formatResolved: (entry) =>
        `${entry.input}→${entry.id}${(entry as { note?: string }).note ? " (note)" : ""}`,
    });
    expect(result.mapping).toEqual(["a→1 (note)"]);
  });

  it("supports custom unresolved formatting", () => {
    const resolvedUsers = [{ input: "a", resolved: false, note: "missing" }];
    const result = buildAllowlistResolutionSummary(resolvedUsers, {
      formatUnresolved: (entry) =>
        `${entry.input}${(entry as { note?: string }).note ? " (missing)" : ""}`,
    });
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

describe("canonicalizeAllowlistWithResolvedIds", () => {
  it("replaces resolved names with ids and keeps unresolved entries", () => {
    const resolvedMap = new Map([
      ["Alice#1234", { input: "Alice#1234", resolved: true, id: "111" }],
      ["bob", { input: "bob", resolved: false }],
    ]);
    const result = canonicalizeAllowlistWithResolvedIds({
      existing: ["Alice#1234", "bob", "222", "*"],
      resolvedMap,
    });
    expect(result).toEqual(["111", "bob", "222", "*"]);
  });

  it("deduplicates ids after canonicalization", () => {
    const resolvedMap = new Map([["alice", { input: "alice", resolved: true, id: "111" }]]);
    const result = canonicalizeAllowlistWithResolvedIds({
      existing: ["alice", "111", "alice"],
      resolvedMap,
    });
    expect(result).toEqual(["111"]);
  });
});

describe("patchAllowlistUsersInConfigEntries", () => {
  it("supports canonicalization strategy for nested users", () => {
    const entries = {
      alpha: { users: ["Alice", "111", "Bob"] },
      beta: { users: ["*"] },
    };
    const resolvedMap = new Map([
      ["Alice", { input: "Alice", resolved: true, id: "111" }],
      ["Bob", { input: "Bob", resolved: false }],
    ]);
    const patched = patchAllowlistUsersInConfigEntries({
      entries,
      resolvedMap,
      strategy: "canonicalize",
    });
    expect((patched.alpha as { users: string[] }).users).toEqual(["111", "Bob"]);
    expect((patched.beta as { users: string[] }).users).toEqual(["*"]);
  });
});

describe("logResolutionSummary", () => {
  it("logs resolved sections and unresolved entries via runtime.log", () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as unknown as RuntimeEnv;
    logResolutionSummary(
      "discord",
      [
        { title: "resolved channels", values: ["c1", "c2"] },
        { title: "resolved guilds", values: ["g1"] },
      ],
      ["unknown-entry"],
      runtime,
    );
    expect(runtime.log).toHaveBeenCalledOnce();
    const logged = (runtime.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(logged).toContain("discord: resolved channels: c1, c2");
    expect(logged).toContain("discord: resolved guilds: g1");
    expect(logged).toContain("discord: unresolved (kept as typed): unknown-entry");
  });

  it("skips empty sections", () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as unknown as RuntimeEnv;
    logResolutionSummary(
      "discord",
      [
        { title: "resolved channels", values: [] },
        { title: "resolved guilds", values: ["g1"] },
      ],
      [],
      runtime,
    );
    const logged = (runtime.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(logged).not.toContain("resolved channels");
    expect(logged).toContain("discord: resolved guilds: g1");
  });

  it("does not log when there is nothing to report", () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as unknown as RuntimeEnv;
    logResolutionSummary("discord", [{ title: "resolved channels", values: [] }], [], runtime);
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("truncates long lists with count suffix", () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as unknown as RuntimeEnv;
    const values = Array.from({ length: 12 }, (_, i) => `c${i}`);
    logResolutionSummary("discord", [{ title: "resolved channels", values }], [], runtime);
    const logged = (runtime.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(logged).toContain("(+4)");
    expect(logged).not.toContain("c8");
  });
});
