import { describe, expect, it } from "vitest";
import { applyMergePatch } from "./merge-patch.js";

describe("applyMergePatch", () => {
  it("replaces arrays by default", () => {
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
        list: [{ id: "primary", memorySearch: { extraPaths: ["/tmp/memory.md"] } }],
      },
    };

    const merged = applyMergePatch(base, patch) as {
      agents?: { list?: Array<{ id?: string; workspace?: string }> };
    };
    expect(merged.agents?.list).toEqual([
      { id: "primary", memorySearch: { extraPaths: ["/tmp/memory.md"] } },
    ]);
  });

  it("merges object arrays by id when enabled", () => {
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
        list: [{ id: "primary", memorySearch: { extraPaths: ["/tmp/memory.md"] } }],
      },
    };

    const merged = applyMergePatch(base, patch, {
      mergeObjectArraysById: true,
    }) as {
      agents?: {
        list?: Array<{
          id?: string;
          workspace?: string;
          memorySearch?: { extraPaths?: string[] };
        }>;
      };
    };
    expect(merged.agents?.list).toHaveLength(2);
    const primary = merged.agents?.list?.find((entry) => entry.id === "primary");
    const secondary = merged.agents?.list?.find((entry) => entry.id === "secondary");
    expect(primary?.workspace).toBe("/tmp/one");
    expect(primary?.memorySearch?.extraPaths).toEqual(["/tmp/memory.md"]);
    expect(secondary?.workspace).toBe("/tmp/two");
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
