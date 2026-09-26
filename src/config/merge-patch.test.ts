// Covers JSON merge-patch behavior for config mutations.
import { describe, expect, it } from "vitest";
import { applyMergePatch } from "./merge-patch.js";

const agentListBase = {
  agents: {
    list: [
      { id: "primary", workspace: "/tmp/one" },
      { id: "secondary", workspace: "/tmp/two" },
    ],
  },
};
const agentListPatch = {
  agents: {
    list: [{ id: "primary", memory: { search: { extraPaths: ["/tmp/memory.md"] } } }],
  },
};

describe("applyMergePatch", () => {
  it("replaces arrays by default", () => {
    expect(applyMergePatch(agentListBase, agentListPatch)).toEqual({
      agents: {
        list: [{ id: "primary", memory: { search: { extraPaths: ["/tmp/memory.md"] } } }],
      },
    });
  });

  it("merges object arrays by id when enabled", () => {
    expect(applyMergePatch(agentListBase, agentListPatch, { mergeObjectArraysById: true })).toEqual(
      {
        agents: {
          list: [
            {
              id: "primary",
              workspace: "/tmp/one",
              memory: { search: { extraPaths: ["/tmp/memory.md"] } },
            },
            { id: "secondary", workspace: "/tmp/two" },
          ],
        },
      },
    );
  });

  it("replaces object arrays by id when the array path is explicit", () => {
    expect(
      applyMergePatch(agentListBase, agentListPatch, {
        mergeObjectArraysById: true,
        replaceArrayPaths: new Set(["agents.list"]),
      }),
    ).toEqual({
      agents: {
        list: [{ id: "primary", memory: { search: { extraPaths: ["/tmp/memory.md"] } } }],
      },
    });
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

  it("merges by id even when patch entries lack id (appends them)", () => {
    const patch = {
      agents: { list: [{ id: "primary", model: "new-model" }, { workspace: "/tmp/orphan" }] },
    };
    expect(applyMergePatch(agentListBase, patch, { mergeObjectArraysById: true })).toEqual({
      agents: {
        list: [
          { id: "primary", workspace: "/tmp/one", model: "new-model" },
          { id: "secondary", workspace: "/tmp/two" },
          { workspace: "/tmp/orphan" },
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
