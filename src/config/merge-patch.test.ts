// Covers JSON merge-patch behavior for config mutations.
import { describe, expect, it } from "vitest";
import { applyMergePatch, createMergePatch, mergePatchConflicts } from "./merge-patch.js";

describe("applyMergePatch", () => {
  function makeAgentListBaseAndPatch() {
    const base = {
      agents: {
        list: [
          { id: "primary", workspace: "/tmp/one" },
          { id: "secondary", workspace: "/tmp/two" },
        ],
      },
    };
    const patch = {
      agents: {
        list: [{ id: "primary", memory: { search: { extraPaths: ["/tmp/memory.md"] } } }],
      },
    };
    return { base, patch };
  }

  it("replaces arrays by default", () => {
    const { base, patch } = makeAgentListBaseAndPatch();

    const merged = applyMergePatch(base, patch) as {
      agents?: { list?: Array<{ id?: string; workspace?: string }> };
    };
    expect(merged.agents?.list).toEqual([
      { id: "primary", memory: { search: { extraPaths: ["/tmp/memory.md"] } } },
    ]);
  });

  it("merges object arrays by id when enabled", () => {
    const { base, patch } = makeAgentListBaseAndPatch();

    const merged = applyMergePatch(base, patch, {
      mergeObjectArraysById: true,
    }) as {
      agents?: {
        list?: Array<{
          id?: string;
          workspace?: string;
          memory?: { search?: { extraPaths?: string[] } };
        }>;
      };
    };
    expect(merged.agents?.list).toHaveLength(2);
    const primary = merged.agents?.list?.find((entry) => entry.id === "primary");
    const secondary = merged.agents?.list?.find((entry) => entry.id === "secondary");
    expect(primary?.workspace).toBe("/tmp/one");
    expect(primary?.memory?.search?.extraPaths).toEqual(["/tmp/memory.md"]);
    expect(secondary?.workspace).toBe("/tmp/two");
  });

  it("replaces object arrays by id when the array path is explicit", () => {
    const { base, patch } = makeAgentListBaseAndPatch();

    const merged = applyMergePatch(base, patch, {
      mergeObjectArraysById: true,
      replaceArrayPaths: new Set(["agents.list"]),
    }) as {
      agents?: {
        list?: Array<{ id?: string; memory?: { search?: { extraPaths?: string[] } } }>;
      };
    };

    expect(merged.agents?.list).toEqual([
      { id: "primary", memory: { search: { extraPaths: ["/tmp/memory.md"] } } },
    ]);
  });

  it("replaces nested arrays in id-keyed entries when the nested path is explicit", () => {
    const base = {
      agents: {
        list: [
          { id: "primary", skills: ["a", "b"] },
          { id: "secondary", skills: ["c"] },
        ],
      },
    };
    const patch = {
      agents: {
        list: [{ id: "primary", skills: ["a"] }],
      },
    };

    const merged = applyMergePatch(base, patch, {
      mergeObjectArraysById: true,
      replaceArrayPaths: new Set(["agents.list[].skills"]),
    }) as {
      agents?: { list?: Array<{ id?: string; skills?: string[] }> };
    };

    expect(merged.agents?.list).toEqual([
      { id: "primary", skills: ["a"] },
      { id: "secondary", skills: ["c"] },
    ]);
  });

  it("merges by id even when patch entries lack id (appends them)", () => {
    const base = {
      agents: {
        list: [
          { id: "primary", workspace: "/tmp/one" },
          { id: "secondary", workspace: "/tmp/two" },
        ],
      },
    };
    const patch = {
      agents: {
        list: [{ id: "primary", model: "new-model" }, { workspace: "/tmp/orphan" }],
      },
    };

    const merged = applyMergePatch(base, patch, {
      mergeObjectArraysById: true,
    }) as {
      agents?: {
        list?: Array<{ id?: string; workspace?: string; model?: string }>;
      };
    };
    expect(merged.agents?.list).toHaveLength(3);
    const primary = merged.agents?.list?.find((entry) => entry.id === "primary");
    expect(primary?.workspace).toBe("/tmp/one");
    expect(primary?.model).toBe("new-model");
    expect(merged.agents?.list?.[1]?.id).toBe("secondary");
    expect(merged.agents?.list?.[2]?.workspace).toBe("/tmp/orphan");
  });

  it("does not destroy agents list when patching a single agent by id", () => {
    const base = {
      agents: {
        list: [
          { id: "main", default: true, workspace: "/home/main" },
          { id: "ota", workspace: "/home/ota" },
          { id: "trading", workspace: "/home/trading" },
          { id: "codex", workspace: "/home/codex" },
        ],
      },
    };
    const patch = {
      agents: {
        list: [{ id: "main", model: "claude-opus-4-20250918" }],
      },
    };

    const merged = applyMergePatch(base, patch, {
      mergeObjectArraysById: true,
    }) as {
      agents?: {
        list?: Array<{ id?: string; workspace?: string; model?: string; default?: boolean }>;
      };
    };
    expect(merged.agents?.list).toHaveLength(4);
    const main = merged.agents?.list?.find((entry) => entry.id === "main");
    expect(main?.model).toBe("claude-opus-4-20250918");
    expect(main?.default).toBe(true);
    expect(main?.workspace).toBe("/home/main");
    expect(merged.agents?.list?.find((entry) => entry.id === "ota")?.workspace).toBe("/home/ota");
    expect(merged.agents?.list?.find((entry) => entry.id === "trading")?.workspace).toBe(
      "/home/trading",
    );
    expect(merged.agents?.list?.find((entry) => entry.id === "codex")?.workspace).toBe(
      "/home/codex",
    );
  });

  it("keeps existing id entries when patch mixes id and primitive entries", () => {
    const base = {
      agents: {
        list: [
          { id: "primary", workspace: "/tmp/one" },
          { id: "secondary", workspace: "/tmp/two" },
        ],
      },
    };
    const patch = {
      agents: {
        list: [{ id: "primary", workspace: "/tmp/one-updated" }, "non-object entry"],
      },
    };

    const merged = applyMergePatch(base, patch, {
      mergeObjectArraysById: true,
    }) as {
      agents?: {
        list?: Array<{ id?: string; workspace?: string } | string>;
      };
    };

    expect(merged.agents?.list).toHaveLength(3);
    const primary = merged.agents?.list?.find(
      (entry): entry is { id?: string; workspace?: string } =>
        typeof entry === "object" && entry !== null && "id" in entry && entry.id === "primary",
    );
    const secondary = merged.agents?.list?.find(
      (entry): entry is { id?: string; workspace?: string } =>
        typeof entry === "object" && entry !== null && "id" in entry && entry.id === "secondary",
    );
    expect(primary?.workspace).toBe("/tmp/one-updated");
    expect(secondary?.workspace).toBe("/tmp/two");
    expect(merged.agents?.list?.[2]).toBe("non-object entry");
  });

  it("falls back to replacement for non-id arrays even when enabled", () => {
    const base = {
      channels: {
        telegram: { allowFrom: ["111", "222"] },
      },
    };
    const patch = {
      channels: {
        telegram: { allowFrom: ["333"] },
      },
    };

    const merged = applyMergePatch(base, patch, {
      mergeObjectArraysById: true,
    }) as {
      channels?: {
        telegram?: { allowFrom?: string[] };
      };
    };
    expect(merged.channels?.telegram?.allowFrom).toEqual(["333"]);
  });
});

describe("stack-safe deep merge-patch", () => {
  function buildNestedObject(
    depth: number,
    leaf: Record<string, unknown>,
  ): Record<string, unknown> {
    let value: Record<string, unknown> = leaf;
    for (let i = 0; i < depth; i += 1) {
      value = { level: value };
    }
    return value;
  }

  function readDeepLeaf(value: unknown, depth: number): unknown {
    let current = value;
    for (let i = 0; i < depth; i += 1) {
      if (typeof current !== "object" || current === null || Array.isArray(current)) {
        return undefined;
      }
      current = (current as Record<string, unknown>).level;
    }
    return current;
  }

  it("diffs a deeply nested document without a call-stack overflow", () => {
    const depth = 5_000;
    const base = buildNestedObject(depth, { leaf: "old" });
    const target = buildNestedObject(depth, { leaf: "new" });
    const patch = createMergePatch(base, target);
    expect(readDeepLeaf(patch, depth)).toEqual({ leaf: "new" });
    const applied = applyMergePatch(base, patch as Record<string, unknown>);
    expect(readDeepLeaf(applied, depth)).toEqual({ leaf: "new" });
  });

  it("clones a deeply nested addition without a call-stack overflow", () => {
    const depth = 5_000;
    const base = { other: true };
    const target = buildNestedObject(depth, { leaf: "added" });
    const patch = createMergePatch(base, { other: true, deep: target });
    expect(readDeepLeaf((patch as Record<string, unknown>).deep, depth)).toEqual({
      leaf: "added",
    });
  });

  it("reports no conflict for a deeply nested unchanged document", () => {
    const depth = 5_000;
    const base = buildNestedObject(depth, { leaf: "value" });
    const patch = createMergePatch(base, base);
    expect(mergePatchConflicts(base, base, patch)).toBe(false);
  });

  it("applies a deep patch through plugins.entries.config without a call-stack overflow", () => {
    const depth = 5_000;
    const base = {
      plugins: { entries: { probe: { config: buildNestedObject(depth, { leaf: 1 }) } } },
    };
    const patch = {
      plugins: { entries: { probe: { config: buildNestedObject(depth, { leaf: 2 }) } } },
    };
    const merged = applyMergePatch(base, patch) as typeof base;
    expect(readDeepLeaf(merged.plugins.entries.probe.config, depth)).toEqual({ leaf: 2 });
  });

  it("keeps an authored __proto__ key as inert own data when cloning an added subtree", () => {
    // JSON.parse mints an own enumerable `__proto__` data property; the object
    // literal form would set a prototype instead, so both sides parse.
    const target = JSON.parse('{"added":{"__proto__":{"flag":true},"kept":1}}') as Record<
      string,
      unknown
    >;
    const patch = createMergePatch({}, target) as Record<string, unknown>;
    const added = patch.added as Record<string, unknown>;
    expect(Object.hasOwn(added, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(added)).toBe(Object.prototype);
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- The round-trip mints an own `__proto__` key on both sides; structuredClone cannot express that shape.
    expect(JSON.parse(JSON.stringify(added))).toEqual(
      JSON.parse('{"__proto__":{"flag":true},"kept":1}'),
    );
  });
});
