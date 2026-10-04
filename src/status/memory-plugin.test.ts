import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { resolveMemoryPluginStatus } from "./memory-plugin.js";

describe("resolveMemoryPluginStatus", () => {
  it.each([
    { name: "explicit memory-core", slot: "memory-core", entry: "memory-core" },
    { name: "implicit memory-core", slot: undefined, entry: "memory-core" },
    { name: "custom memory slot", slot: "records", entry: "records" },
    { name: "trimmed slot and entry", slot: " records ", entry: " records " },
  ])("reports disabled $name", ({ slot, entry }) => {
    expect(
      resolveMemoryPluginStatus({
        plugins: {
          slots: { memory: slot },
          entries: { [entry]: { enabled: false } },
        },
      }),
    ).toEqual({
      enabled: false,
      slot: entry.trim(),
      reason: `plugins.entries.${entry.trim()}.enabled=false`,
    });
  });

  const enabledCases: { name: string; config: OpenClawConfig; slot: string }[] = [
    { name: "default selection", config: {}, slot: "memory-core" },
    {
      name: "explicitly enabled selected entry",
      config: { plugins: { entries: { "memory-core": { enabled: true } } } },
      slot: "memory-core",
    },
    {
      name: "unrelated disabled entry",
      config: { plugins: { entries: { records: { enabled: false } } } },
      slot: "memory-core",
    },
    {
      name: "disabled search",
      config: { memory: { search: { enabled: false } } },
      slot: "memory-core",
    },
    { name: "custom slot", config: { plugins: { slots: { memory: "records" } } }, slot: "records" },
    {
      name: "trimmed custom slot",
      config: { plugins: { slots: { memory: " records " } } },
      slot: "records",
    },
    { name: "blank slot", config: { plugins: { slots: { memory: "  " } } }, slot: "memory-core" },
    {
      name: "later normalized entry override",
      config: {
        plugins: {
          entries: { "memory-core": { enabled: false }, " memory-core ": { enabled: true } },
        },
      },
      slot: "memory-core",
    },
  ];
  it.each(enabledCases)("preserves $name", ({ config, slot }) => {
    expect(resolveMemoryPluginStatus(config)).toEqual({ enabled: true, slot });
  });

  it("preserves explicit disablement across normalized entry merges", () => {
    expect(
      resolveMemoryPluginStatus({
        plugins: { entries: { "memory-core": { enabled: false }, " memory-core ": {} } },
      }),
    ).toEqual({
      enabled: false,
      slot: "memory-core",
      reason: "plugins.entries.memory-core.enabled=false",
    });
  });

  it("preserves global plugin disablement", () => {
    expect(
      resolveMemoryPluginStatus({
        plugins: { enabled: false, entries: { "memory-core": { enabled: true } } },
      }),
    ).toEqual({ enabled: false, slot: null, reason: "plugins disabled" });
  });

  it.each(["none", " NoNe "])("preserves disabled slot %s", (memory) => {
    expect(resolveMemoryPluginStatus({ plugins: { slots: { memory } } })).toEqual({
      enabled: false,
      slot: null,
      reason: 'plugins.slots.memory="none"',
    });
  });
});
