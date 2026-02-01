import { describe, expect, it } from "vitest";
import { applyMergePatch } from "./merge-patch.js";

describe("applyMergePatch", () => {
  it("replaces primitive values", () => {
    expect(applyMergePatch({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  it("deep merges nested objects", () => {
    const base = { nested: { a: 1, b: 2 } };
    const patch = { nested: { b: 3 } };
    expect(applyMergePatch(base, patch)).toEqual({ nested: { a: 1, b: 3 } });
  });

  it("deletes keys when patch value is null", () => {
    expect(applyMergePatch({ a: 1, b: 2 }, { b: null })).toEqual({ a: 1 });
  });

  it("replaces non-id arrays entirely", () => {
    const base = { arr: [1, 2, 3] };
    const patch = { arr: [4, 5] };
    expect(applyMergePatch(base, patch)).toEqual({ arr: [4, 5] });
  });

  describe("id-based array merging", () => {
    it("merges arrays by id field", () => {
      const base = {
        agents: [
          { id: "a", name: "Agent A", enabled: true },
          { id: "b", name: "Agent B", enabled: true },
        ],
      };
      const patch = {
        agents: [{ id: "b", enabled: false }],
      };
      expect(applyMergePatch(base, patch)).toEqual({
        agents: [
          { id: "a", name: "Agent A", enabled: true },
          { id: "b", name: "Agent B", enabled: false },
        ],
      });
    });

    it("appends new items with ids not in base", () => {
      const base = {
        agents: [{ id: "a", name: "Agent A" }],
      };
      const patch = {
        agents: [{ id: "c", name: "Agent C" }],
      };
      expect(applyMergePatch(base, patch)).toEqual({
        agents: [
          { id: "a", name: "Agent A" },
          { id: "c", name: "Agent C" },
        ],
      });
    });

    it("preserves base items not in patch", () => {
      const base = {
        list: [
          { id: "1", value: "one" },
          { id: "2", value: "two" },
          { id: "3", value: "three" },
        ],
      };
      const patch = {
        list: [{ id: "2", value: "TWO" }],
      };
      expect(applyMergePatch(base, patch)).toEqual({
        list: [
          { id: "1", value: "one" },
          { id: "2", value: "TWO" },
          { id: "3", value: "three" },
        ],
      });
    });

    it("deep merges nested properties within id-matched items", () => {
      const base = {
        agents: [
          {
            id: "nova",
            identity: { name: "Nova", theme: "Owl" },
            model: { primary: "claude" },
          },
        ],
      };
      const patch = {
        agents: [
          {
            id: "nova",
            model: { fallbacks: ["gpt-4"] },
          },
        ],
      };
      expect(applyMergePatch(base, patch)).toEqual({
        agents: [
          {
            id: "nova",
            identity: { name: "Nova", theme: "Owl" },
            model: { primary: "claude", fallbacks: ["gpt-4"] },
          },
        ],
      });
    });

    it("replaces array if base is not id-based", () => {
      const base = { arr: [1, 2, 3] };
      const patch = { arr: [{ id: "a", name: "A" }] };
      expect(applyMergePatch(base, patch)).toEqual({
        arr: [{ id: "a", name: "A" }],
      });
    });

    it("handles empty patch array", () => {
      const base = { agents: [{ id: "a", name: "A" }] };
      const patch = { agents: [] };
      // Empty array is not id-based, so it replaces
      expect(applyMergePatch(base, patch)).toEqual({ agents: [] });
    });

    it("merges top-level id-based arrays", () => {
      const base = [
        { id: "a", value: 1 },
        { id: "b", value: 2 },
      ];
      const patch = [{ id: "a", value: 10 }];
      expect(applyMergePatch(base, patch)).toEqual([
        { id: "a", value: 10 },
        { id: "b", value: 2 },
      ]);
    });

    it("replaces top-level array if base is not id-based", () => {
      const base = [1, 2, 3];
      const patch = [{ id: "a", name: "A" }];
      expect(applyMergePatch(base, patch)).toEqual([{ id: "a", name: "A" }]);
    });
  });
});
