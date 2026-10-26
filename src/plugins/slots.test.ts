import { describe, expect, it, vi } from "vitest";
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
  it("selects the declared engine rather than its plugin ID", () => {
    const warn = vi.fn();
    const result = applyExclusiveSlotSelection({
      config: {},
      selectedId: "vendor-plugin",
      selectedKind: "context-engine",
      contextEngineIds: ["CanonicalEngine"],
      warn,
    });
    expect(result.plugins?.slots?.contextEngine).toBe("CanonicalEngine");
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["other-engine", "none", "second-engine"])("preserves explicit choice %s", (choice) => {
    const config: OpenClawConfig = { plugins: { slots: { contextEngine: choice } } };
    const result = applyExclusiveSlotSelection({
      config,
      selectedId: "vendor-plugin",
      selectedKind: "context-engine",
      contextEngineIds: ["second-engine"],
    });
    expect(result).toBe(config);
  });

  it("does not guess a multi-engine default while still selecting a memory slot", () => {
    const warn = vi.fn();
    const result = applyExclusiveSlotSelection({
      config: {},
      selectedId: "vendor-plugin",
      selectedKind: ["memory", "context-engine"],
      contextEngineIds: ["first", "second"],
      warn,
    });
    expect(result.plugins?.slots).toEqual({ memory: "vendor-plugin" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("explicitly"));
  });

  it("reports the multi-engine warning even when no config changes", () => {
    const warn = vi.fn();
    const config: OpenClawConfig = {};
    const result = applyExclusiveSlotSelection({
      config,
      selectedId: "vendor-plugin",
      selectedKind: "context-engine",
      contextEngineIds: ["first", "second"],
      warn,
    });
    expect(result).toBe(config);
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("explicitly"));
  });

  it.each([undefined, "owner-a"])(
    "preserves a plugin-ID selector without legacy ownership: %s",
    (legacyContextEngineOwnerId) => {
      const config: OpenClawConfig = { plugins: { slots: { contextEngine: "vendor-plugin" } } };
      const result = applyExclusiveSlotSelection({
        config,
        selectedId: "vendor-plugin",
        selectedKind: "context-engine",
        contextEngineIds: ["canonical-engine"],
        legacyContextEngineOwnerId,
      });
      expect(result).toBe(config);
    },
  );

  it("repairs the old plugin-ID selection for a uniquely declared engine", () => {
    const result = applyExclusiveSlotSelection({
      config: { plugins: { slots: { contextEngine: "vendor-plugin" } } },
      legacyContextEngineOwnerId: "vendor-plugin",
      selectedId: "vendor-plugin",
      selectedKind: "context-engine",
      contextEngineIds: ["canonical-engine"],
    });
    expect(result.plugins?.slots?.contextEngine).toBe("canonical-engine");
  });

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
