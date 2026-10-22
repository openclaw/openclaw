import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyExclusiveSlotSelection,
  hasKind,
  kindsEqual,
  resetPluginSlotsToDefaults,
} from "./slots.js";

describe("resetPluginSlotsToDefaults", () => {
  it("resets every slot owned by the plugin", () => {
    const slots = { memory: "dual-plugin", contextEngine: "dual-plugin" };
    expect(resetPluginSlotsToDefaults(slots, "dual-plugin")).toBeUndefined();
  });

  it("preserves slot state when the plugin owns no slot", () => {
    const slots = { memory: "memory-core", contextEngine: "legacy" };

    expect(resetPluginSlotsToDefaults(slots, "other-plugin")).toBe(slots);
    expect(resetPluginSlotsToDefaults(undefined, "other-plugin")).toBeUndefined();
  });
});

describe("applyExclusiveSlotSelection", () => {
  it.each([
    [undefined, "memory-core"],
    ["memory", "memory-core"],
    ["memory-core", "memory"],
  ] as const)("selects %s → %s without changing enabled entries", (previous, selectedId) => {
    const entries = {
      "memory-core": { enabled: true },
      ...(previous ? { memory: { enabled: true } } : {}),
    };
    const config: OpenClawConfig = {
      plugins: { entries, ...(previous ? { slots: { memory: previous } } : {}) },
    };
    const result = applyExclusiveSlotSelection({ config, selectedId, selectedKind: "memory" });
    if (!previous) {
      expect(result).toBe(config);
    } else {
      expect(result).not.toBe(config);
      expect(result.plugins?.entries).toEqual(entries);
      if (selectedId === "memory-core") {
        expect(result.plugins).not.toHaveProperty("slots");
      } else {
        expect(result.plugins?.slots).toEqual({ memory: selectedId });
      }
    }
  });

  it("skips changes when no exclusive slot applies", () => {
    const config = {};
    expect(applyExclusiveSlotSelection({ config, selectedId: "custom" })).toBe(config);
  });
});

it("hasKind matches within a kind array", () => {
  expect(hasKind(["memory", "context-engine"], "memory")).toBe(true);
  expect(hasKind(["memory", "context-engine"], "context-engine")).toBe(true);
});

it("kindsEqual matches string against single-element array", () => {
  expect(kindsEqual("memory", ["memory"])).toBe(true);
});
