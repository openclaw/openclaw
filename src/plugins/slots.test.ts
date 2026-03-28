import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { applyExclusiveSlotSelection } from "./slots.js";

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

  const runMemorySelection = (config: OpenClawConfig, selectedId = "memory") =>
    applyExclusiveSlotSelection({
      config,
      selectedId,
      selectedKind: "memory",
      registry: {
        plugins: [
          { id: "memory-core", kind: "memory" },
          { id: "memory", kind: "memory" },
        ],
      },
    });

  function expectSelectionWarnings(
    warnings: string[],
    params: {
      contains?: readonly string[];
      excludes?: readonly string[];
    },
  ) {
    for (const warning of params.contains ?? []) {
      expect(warnings).toContain(warning);
    }
    for (const warning of params.excludes ?? []) {
      expect(warnings).not.toContain(warning);
    }
  }

  it("selects the slot and disables other entries for the same kind", () => {
    const config = createMemoryConfig({
      slots: { memory: "memory-core" },
      entries: { "memory-core": { enabled: true } },
    });
    const result = runMemorySelection(config);

    expect(result.changed).toBe(true);
    expect(result.config.plugins?.slots?.memory).toBe("memory");
    expect(result.config.plugins?.entries?.["memory-core"]?.enabled).toBe(false);
    expect(result.warnings).toContain(
      'Exclusive slot "memory" switched from "memory-core" to "memory".',
    );
    expect(result.warnings).toContain('Disabled other "memory" slot plugins: memory-core.');
  });

  it("does nothing when the slot already matches", () => {
    const config = createMemoryConfig({
      slots: { memory: "memory" },
    });
    const result = applyExclusiveSlotSelection({
      config,
      selectedId: "memory",
      selectedKind: "memory",
      registry: { plugins: [{ id: "memory", kind: "memory" }] },
    });

    expect(result.changed).toBe(false);
    expect(result.warnings).toHaveLength(0);
    expect(result.config).toBe(config);
  });

  it.each([
    {
      name: "warns when the slot falls back to a default",
      config: createMemoryConfig(),
      selectedId: "memory",
      expectedDisabled: undefined,
      warningChecks: {
        contains: ['Exclusive slot "memory" switched from "memory-core" to "memory".'],
      },
    },
    {
      name: "keeps disabled competing plugins disabled without adding disable warnings",
      config: createMemoryConfig({
        entries: {
          "memory-core": { enabled: false },
        },
      }),
      selectedId: "memory",
      expectedDisabled: false,
      warningChecks: {
        contains: ['Exclusive slot "memory" switched from "memory-core" to "memory".'],
        excludes: ['Disabled other "memory" slot plugins: memory-core.'],
      },
    },
  ] as const)("$name", ({ config, selectedId, expectedDisabled, warningChecks }) => {
    const result = runMemorySelection(config, selectedId);

    expect(result.changed).toBe(true);
    if (expectedDisabled != null) {
      expect(result.config.plugins?.entries?.["memory-core"]?.enabled).toBe(expectedDisabled);
    }
    expectSelectionWarnings(result.warnings, warningChecks);
  });

  it("skips changes when no exclusive slot applies", () => {
    const config: OpenClawConfig = {};
    const result = applyExclusiveSlotSelection({
      config,
      selectedId: "custom",
    });

    expect(result.changed).toBe(false);
    expect(result.warnings).toHaveLength(0);
    expect(result.config).toBe(config);
  });
});
