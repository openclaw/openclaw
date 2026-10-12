// Covers JSON merge-patch behavior for config mutations.
import { describe, expect, it } from "vitest";
import { applyMergePatch, createMergePatch, mergePatchConflicts } from "./merge-patch.js";

const agentListBase = {
  agents: {
    list: [
      { id: "primary", workspace: "/tmp/one" },
      { id: "secondary", workspace: "/tmp/two" },
    ],
  },
};

describe("applyMergePatch", () => {
  it("replaces nested arrays in id-keyed entries when the nested path is explicit", () => {
    const base = {
      agents: {
        list: [
          { id: "primary", skills: ["a", "b"] },
          { id: "secondary", skills: ["c"] },
        ],
      },
    };
    const patch = { agents: { list: [{ id: "primary", skills: ["a"] }] } };
    expect(
      applyMergePatch(base, patch, {
        mergeObjectArraysById: true,
        replaceArrayPaths: new Set(["agents.list[].skills"]),
      }),
    ).toEqual({
      agents: {
        list: [
          { id: "primary", skills: ["a"] },
          { id: "secondary", skills: ["c"] },
        ],
      },
    });
  });

  it("keeps existing id entries when patch mixes id and primitive entries", () => {
    const patch = {
      agents: {
        list: [{ id: "primary", workspace: "/tmp/one-updated" }, "non-object entry"],
      },
    };
    expect(applyMergePatch(agentListBase, patch, { mergeObjectArraysById: true })).toEqual({
      agents: {
        list: [
          { id: "primary", workspace: "/tmp/one-updated" },
          { id: "secondary", workspace: "/tmp/two" },
          "non-object entry",
        ],
      },
    });
  });

  it("falls back to replacement for non-id arrays even when enabled", () => {
    const base = { channels: { telegram: { allowFrom: ["111", "222"] } } };
    const patch = { channels: { telegram: { allowFrom: ["333"] } } };
    expect(applyMergePatch(base, patch, { mergeObjectArraysById: true })).toEqual({
      channels: { telegram: { allowFrom: ["333"] } },
    });
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
