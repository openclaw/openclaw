import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  collectLegacyMemorySlotWarnings,
  maybeRepairLegacyMemorySlotConfig,
  scanLegacyMemorySlotConfig,
} from "./legacy-memory-slot.js";

describe("legacy memory slot doctor migration", () => {
  it("migrates global legacy memory slot to memory.recall", () => {
    const cfg = {
      plugins: {
        slots: {
          memory: "memory-lancedb",
          contextEngine: "legacy",
        },
      },
    } as OpenClawConfig;

    expect(scanLegacyMemorySlotConfig(cfg)).toEqual([
      {
        pathLabel: "plugins.slots.memory",
        legacyValue: "memory-lancedb",
        recallValue: undefined,
        conflict: false,
      },
    ]);

    const result = maybeRepairLegacyMemorySlotConfig(cfg);

    expect(result.changes).toEqual([
      "- plugins.slots.memory: copied legacy memory slot to memory.recall (memory-lancedb) and kept the legacy key for plugin compatibility.",
    ]);
    expect(result.warnings).toEqual([
      "- plugins.slots.memory: legacy memory slot remains for plugin compatibility; use memory.recall as the canonical selector.",
    ]);
    expect(result.config.plugins?.slots).toEqual({
      memory: "memory-lancedb",
      "memory.recall": "memory-lancedb",
      contextEngine: "legacy",
    });
  });

  it("migrates per-agent legacy memory slot overrides", () => {
    const cfg = {
      agents: {
        list: [
          {
            id: "main",
            plugins: {
              slots: {
                memory: "openclaw-honcho",
              },
            },
          },
        ],
      },
    } as OpenClawConfig;

    const result = maybeRepairLegacyMemorySlotConfig(cfg);

    expect(result.changes).toEqual([
      "- agents.list.0.plugins.slots.memory: copied legacy memory slot to memory.recall (openclaw-honcho) and kept the legacy key for plugin compatibility.",
    ]);
    expect(result.warnings).toEqual([
      "- agents.list.0.plugins.slots.memory: legacy memory slot remains for plugin compatibility; use memory.recall as the canonical selector.",
    ]);
    expect(result.config.agents?.list?.[0]?.plugins?.slots).toEqual({
      memory: "openclaw-honcho",
      "memory.recall": "openclaw-honcho",
    });
  });

  it("keeps redundant legacy memory when memory.recall already matches", () => {
    const cfg = {
      plugins: {
        slots: {
          memory: "memory-lancedb",
          "memory.recall": "memory-lancedb",
        },
      },
    } as OpenClawConfig;

    const result = maybeRepairLegacyMemorySlotConfig(cfg);

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      "- plugins.slots.memory: legacy memory slot already matches memory.recall and remains for plugin compatibility.",
    ]);
    expect(result.config).toBe(cfg);
  });

  it("warns but does not mutate conflicting legacy and recall slots", () => {
    const cfg = {
      plugins: {
        slots: {
          memory: "memory-lancedb",
          "memory.recall": "memory-core",
        },
      },
    } as OpenClawConfig;

    const result = maybeRepairLegacyMemorySlotConfig(cfg);

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      '- plugins.slots.memory: kept legacy memory slot because memory.recall is already "memory-core" while memory is "memory-lancedb".',
    ]);
    expect(result.config).toBe(cfg);
  });

  it("formats doctor preview warnings for fixable and conflicting legacy slots", () => {
    const warnings = collectLegacyMemorySlotWarnings({
      doctorFixCommand: "openclaw doctor --fix",
      hits: [
        {
          pathLabel: "plugins.slots.memory",
          legacyValue: "memory-lancedb",
          conflict: false,
        },
        {
          pathLabel: "agents.list.0.plugins.slots.memory",
          legacyValue: "memory-a",
          recallValue: "memory-b",
          conflict: true,
        },
      ],
    });

    expect(warnings).toEqual([
      "- Found 2 legacy memory slot selectors (for example plugins.slots.memory).",
      '- `plugins.slots.memory` is deprecated; use `plugins.slots["memory.recall"]` for factual recall provider selection.',
      "- Doctor keeps non-conflicting legacy memory selectors in place for plugin compatibility during the extended migration window.",
      '- Run "openclaw doctor --fix" to migrate 1 non-conflicting legacy memory slot.',
      "- 1 legacy memory slot also defines a different memory.recall value; resolve it manually so doctor does not guess.",
    ]);
  });
});
