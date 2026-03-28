import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { applyExclusiveSlotSelection } from "./slots.js";
import type { PluginKind } from "./types.js";

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

  function expectMemorySelectionState(
    result: ReturnType<typeof applyExclusiveSlotSelection>,
    params: {
      changed: boolean;
      selectedId?: string;
      disabledCompetingPlugin?: boolean;
    },
  ) {
    expect(result.changed).toBe(params.changed);
    if (params.selectedId) {
      expect(result.config.plugins?.slots?.memory).toBe(params.selectedId);
    }
    if (params.disabledCompetingPlugin != null) {
      expect(result.config.plugins?.entries?.["memory-core"]?.enabled).toBe(
        params.disabledCompetingPlugin,
      );
    }
  }

  function expectSelectionWarnings(
    warnings: string[],
    params: {
      contains?: readonly string[];
      excludes?: readonly string[];
    },
  ) {
    if (params.contains?.length) {
      expect(warnings).toEqual(expect.arrayContaining([...params.contains]));
    }
    for (const warning of params.excludes ?? []) {
      expect(warnings).not.toEqual(expect.arrayContaining([warning]));
    }
  }

  function expectUnchangedSelection(result: ReturnType<typeof applyExclusiveSlotSelection>) {
    expect(result.changed).toBe(false);
    expect(result.warnings).toHaveLength(0);
  }

  function expectUnchangedSelectionCase(params: {
    config: OpenClawConfig;
    selectedId: string;
    selectedKind?: PluginKind;
    registry?: { plugins: ReadonlyArray<{ id: string; kind?: PluginKind }> };
  }) {
    const result = applyExclusiveSlotSelection({
      config: params.config,
      selectedId: params.selectedId,
      ...(params.selectedKind ? { selectedKind: params.selectedKind } : {}),
      ...(params.registry
        ? {
            registry: {
              plugins: [...params.registry.plugins],
            },
          }
        : {}),
    });

    expectUnchangedSelection(result);
    expect(result.config).toBe(params.config);
  }

  it("selects the slot and disables other entries for the same kind", () => {
    const config = createMemoryConfig({
      slots: { memory: "memory-core" },
      entries: { "memory-core": { enabled: true } },
    });
    const result = runMemorySelection(config);

    expectMemorySelectionState(result, {
      changed: true,
      selectedId: "memory",
      disabledCompetingPlugin: false,
    });
    expectSelectionWarnings(result.warnings, {
      contains: [
        'Exclusive slot "memory" switched from "memory-core" to "memory".',
        'Disabled other "memory" slot plugins: memory-core.',
      ],
    });
  });

  it.each([
    {
      name: "does nothing when the slot already matches",
      config: createMemoryConfig({
        slots: { memory: "memory" },
      }),
      selectedId: "memory",
      selectedKind: "memory",
      registry: { plugins: [{ id: "memory", kind: "memory" }] },
    },
    {
      name: "skips changes when no exclusive slot applies",
      config: {} as OpenClawConfig,
      selectedId: "custom",
    },
  ] as const)("$name", ({ config, selectedId, selectedKind, registry }) => {
    expectUnchangedSelectionCase({
      config,
      selectedId,
      ...(selectedKind ? { selectedKind } : {}),
      ...(registry ? { registry: { plugins: [...registry.plugins] } } : {}),
    });
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

    expectMemorySelectionState(result, {
      changed: true,
      ...(expectedDisabled != null ? { disabledCompetingPlugin: expectedDisabled } : {}),
    });
    expectSelectionWarnings(result.warnings, warningChecks);
  });
});
