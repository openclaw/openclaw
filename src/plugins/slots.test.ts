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
  const selectMemory = (config: OpenClawConfig, selectedId = "memory-core") =>
    applyExclusiveSlotSelection({ config, selectedId, selectedKind: "memory" });

  it("keeps the default memory selection implicit", () => {
    const config: OpenClawConfig = {
      plugins: { entries: { "memory-core": { enabled: true } } },
    };

    expect(selectMemory(config)).toBe(config);
  });

  it("removes an explicit override when selecting the default memory plugin", () => {
    const config: OpenClawConfig = {
      plugins: {
        slots: { memory: "memory" },
        entries: { memory: { enabled: true }, "memory-core": { enabled: true } },
      },
    };

    const result = selectMemory(config);
    expect(result).not.toBe(config);
    expect(result.plugins).not.toHaveProperty("slots");
    expect(result.plugins?.entries?.memory?.enabled).toBe(true);
  });

  it("selects the slot and preserves other enabled entries", () => {
    const config: OpenClawConfig = {
      plugins: {
        slots: { memory: "memory-core" },
        entries: { memory: { enabled: true }, "memory-core": { enabled: true } },
      },
    };
    const result = selectMemory(config, "memory");
    expect(result).not.toBe(config);
    expect(result.plugins).toMatchObject({
      slots: { memory: "memory" },
      entries: { "memory-core": { enabled: true } },
    });
  });

  it("skips changes when no exclusive slot applies", () => {
    const config = {};
    expect(applyExclusiveSlotSelection({ config, selectedId: "custom" })).toBe(config);
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
