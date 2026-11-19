// Covers JSON merge-patch behavior for config mutations.
import { describe, expect, it } from "vitest";
import { applyMergePatch, createMergePatch } from "./merge-patch.js";

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

describe("createMergePatch", () => {
  it("preserves null values in complete id-keyed target rows", () => {
    const base = {
      models: [{ id: "fixture", name: "Old name", thinkingLevelMap: { off: null } }],
    };
    const target = {
      models: [{ id: "fixture", name: "New name", thinkingLevelMap: { off: null } }],
    };

    const patch = createMergePatch(base, target, { mergeObjectArraysById: true });

    expect(patch).toEqual({ models: [{ id: "fixture", name: "New name" }] });
    expect(applyMergePatch(base, patch, { mergeObjectArraysById: true })).toEqual(target);
  });
});
