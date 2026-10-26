import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { applyExclusiveSlotSelection, kindsEqual, resetPluginSlotsToDefaults } from "./slots.js";

function selectEngine(overrides: Partial<Parameters<typeof applyExclusiveSlotSelection>[0]> = {}) {
  return applyExclusiveSlotSelection({
    config: {},
    selectedId: "vendor-plugin",
    selectedKind: "context-engine",
    contextEngineIds: ["canonical-engine"],
    ...overrides,
  });
}

it("resets every slot owned by the plugin", () => {
  const slots = { memory: "dual-plugin", contextEngine: "dual-plugin" };
  expect(resetPluginSlotsToDefaults(slots, "dual-plugin")).toBeUndefined();
});

it("preserves slot state when the plugin owns no slot", () => {
  const slots = { memory: "memory-core", contextEngine: "legacy" };

  expect(resetPluginSlotsToDefaults(slots, "other-plugin")).toBe(slots);
  expect(resetPluginSlotsToDefaults(undefined, "other-plugin")).toBeUndefined();
});
it("selects the declared engine rather than its plugin ID", () => {
  const warn = vi.fn();
  const result = selectEngine({ contextEngineIds: ["CanonicalEngine"], warn });
  expect(result.plugins?.slots?.contextEngine).toBe("CanonicalEngine");
  expect(warn).not.toHaveBeenCalled();
});

it.each([
  ["none", undefined],
  ["second-engine", undefined],
  ["vendor-plugin", "owner-a"],
])("preserves explicit choice %s with legacy owner %s", (choice, legacyContextEngineOwnerId) => {
  const config: OpenClawConfig = { plugins: { slots: { contextEngine: choice } } };
  expect(
    selectEngine({ config, contextEngineIds: ["second-engine"], legacyContextEngineOwnerId }),
  ).toBe(config);
});

it.each([false, true])(
  "warns for multiple engines while selecting memory only when requested: %s",
  (memory) => {
    const warn = vi.fn();
    const config: OpenClawConfig = {};
    const result = selectEngine({
      config,
      selectedKind: memory ? ["memory", "context-engine"] : "context-engine",
      contextEngineIds: ["first", "second"],
      warn,
    });
    if (memory) {
      expect(result.plugins?.slots).toEqual({ memory: "vendor-plugin" });
    } else {
      expect(result).toBe(config);
    }
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("explicitly"));
  },
);

it.each([
  [undefined, "memory-core", undefined],
  ["memory", "memory-core", undefined],
  ["memory-core", "memory", "memory"],
] as const)("selects %s → %s without changing enabled entries", (previous, selectedId, memory) => {
  const entries = {
    "memory-core": { enabled: true },
    ...(previous ? { memory: { enabled: true } } : {}),
  };
  const config: OpenClawConfig = {
    plugins: { entries, ...(previous ? { slots: { memory: previous } } : {}) },
  };
  const result = applyExclusiveSlotSelection({ config, selectedId, selectedKind: "memory" });
  expect(result === config).toBe(previous === undefined);
  expect(result.plugins).toStrictEqual({ entries, ...(memory ? { slots: { memory } } : {}) });
});

it("skips changes when no exclusive slot applies", () => {
  const config = {};
  expect(applyExclusiveSlotSelection({ config, selectedId: "custom" })).toBe(config);
});
it("kindsEqual matches string against single-element array", () => {
  expect(kindsEqual("memory", ["memory"])).toBe(true);
});
