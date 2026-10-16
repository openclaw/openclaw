/** Tests plugin slot normalization and exclusive slot selection behavior. */
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
    expect(
      resetPluginSlotsToDefaults(
        { memory: "dual-plugin", contextEngine: "dual-plugin" },
        "dual-plugin",
      ),
    ).toBeUndefined();
  });

  it("preserves slot state when the plugin owns no slot", () => {
    const slots = { memory: "memory-core", contextEngine: "legacy" };

    expect(resetPluginSlotsToDefaults(slots, "other-plugin")).toBe(slots);
    expect(resetPluginSlotsToDefaults(undefined, "other-plugin")).toBeUndefined();
  });
});

describe("applyExclusiveSlotSelection", () => {
  const createMemoryConfig = (plugins?: OpenClawConfig["plugins"]): OpenClawConfig => ({
    plugins: {
      ...plugins,
      entries: {
        ...plugins?.entries,
        memory: {
          enabled: true,
          ...plugins?.entries?.memory,
        },
      },
    },
  });

  it("keeps the default memory selection implicit", () => {
    const config: OpenClawConfig = {
      plugins: { entries: { "memory-core": { enabled: true } } },
    };

    const result = applyExclusiveSlotSelection({
      config,
      selectedId: "memory-core",
      selectedKind: "memory",
    });

    expect(result).toBe(config);
  });

  it("removes an explicit override when selecting the default memory plugin", () => {
    const config: OpenClawConfig = {
      plugins: {
        slots: { memory: "memory" },
        entries: { memory: { enabled: true }, "memory-core": { enabled: true } },
      },
    };

    const result = applyExclusiveSlotSelection({
      config,
      selectedId: "memory-core",
      selectedKind: "memory",
    });

    expect(result).not.toBe(config);
    expect(result.plugins).not.toHaveProperty("slots");
    expect(result.plugins?.entries?.memory?.enabled).toBe(true);
  });

  it.each([
    {
      name: "selects the slot and preserves other enabled entries",
      config: createMemoryConfig({
        slots: { memory: "memory-core" },
        entries: { "memory-core": { enabled: true } },
      }),
      expectedCoreEnabled: true,
    },
  ] as const)("$name", ({ config, expectedCoreEnabled }) => {
    const result = applyExclusiveSlotSelection({
      config,
      selectedId: "memory",
      selectedKind: "memory",
    });

    expect(result).not.toBe(config);
    expect(result.plugins?.slots?.memory).toBe("memory");
    expect(result.plugins?.entries?.["memory-core"]?.enabled).toBe(expectedCoreEnabled);
  });

  it.each([
    {
      name: "skips changes when no exclusive slot applies",
      config: {} as OpenClawConfig,
      selectedId: "custom",
    },
  ] as const)("$name", ({ config, selectedId }) => {
    const result = applyExclusiveSlotSelection({
      config,
      selectedId,
    });

    expect(result).toBe(config);
  });
});

describe("hasKind", () => {
  it("matches within a kind array", () => {
    expect(hasKind(["memory", "context-engine"], "memory")).toBe(true);
    expect(hasKind(["memory", "context-engine"], "context-engine")).toBe(true);
  });
});

describe("kindsEqual", () => {
  it("matches string against single-element array", () => {
    expect(kindsEqual("memory", ["memory"])).toBe(true);
  });
});
