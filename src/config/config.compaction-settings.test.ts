// Verifies compaction settings config parsing and defaults.
import { describe, expect, it } from "vitest";
import { applyCompactionDefaults } from "./defaults.js";
import type { OpenClawConfig } from "./types.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

function materializeCompactionConfig(
  compaction: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["compaction"],
) {
  const cfg = applyCompactionDefaults({
    agents: {
      defaults: {
        compaction,
      },
    },
  });
  return cfg.agents?.defaults?.compaction;
}

describe("config compaction settings", () => {
  it("preserves memory flush config values", () => {
    const compaction = materializeCompactionConfig({
      mode: "safeguard",
      reserveTokensFloor: 12_345,
      identifierPolicy: "custom",
      identifierInstructions: "Keep ticket IDs unchanged.",
      qualityGuard: {
        enabled: true,
        maxRetries: 2,
      },
      midTurnPrecheck: {
        enabled: true,
      },
      memoryFlush: {
        enabled: false,
        model: "ollama/qwen3:8b",
        softThresholdTokens: 1234,
        prompt: "Write notes.",
        systemPrompt: "Flush memory now.",
      },
      maxActiveTranscriptBytes: "20mb",
    });

    expect(compaction?.reserveTokensFloor).toBe(12_345);
    expect(compaction?.mode).toBe("safeguard");
    expect(compaction?.reserveTokens).toBeUndefined();
    expect(compaction?.keepRecentTokens).toBeUndefined();
    expect(compaction?.identifierPolicy).toBe("custom");
    expect(compaction?.identifierInstructions).toBe("Keep ticket IDs unchanged.");
    expect(compaction?.qualityGuard?.enabled).toBe(true);
    expect(compaction?.qualityGuard?.maxRetries).toBe(2);
    expect(compaction?.midTurnPrecheck?.enabled).toBe(true);
    expect(compaction?.memoryFlush?.enabled).toBe(false);
    expect(compaction?.memoryFlush?.model).toBe("ollama/qwen3:8b");
    expect(compaction?.memoryFlush?.softThresholdTokens).toBe(1234);
    expect(compaction?.memoryFlush?.prompt).toBe("Write notes.");
    expect(compaction?.memoryFlush?.systemPrompt).toBe("Flush memory now.");
    expect(compaction?.maxActiveTranscriptBytes).toBe("20mb");
  });

  it("preserves legacy compaction override values", () => {
    const compaction = materializeCompactionConfig({
      reserveTokens: 15_000,
      keepRecentTokens: 12_000,
    });

    expect(compaction?.reserveTokens).toBe(15_000);
    expect(compaction?.keepRecentTokens).toBe(12_000);
  });

  it("defaults compaction mode to safeguard", () => {
    const compaction = materializeCompactionConfig({
      reserveTokensFloor: 9000,
    });

    expect(compaction?.mode).toBe("safeguard");
    expect(compaction?.reserveTokensFloor).toBe(9000);
  });

  it("preserves recent turn safeguard values during materialization", () => {
    const compaction = materializeCompactionConfig({
      mode: "safeguard",
      recentTurnsPreserve: 4,
    });

    expect(compaction?.recentTurnsPreserve).toBe(4);
  });

  it("preserves oversized quality guard retry values for runtime clamping", () => {
    const compaction = materializeCompactionConfig({
      qualityGuard: {
        maxRetries: 99,
      },
    });

    expect(compaction?.qualityGuard?.maxRetries).toBe(99);
  });

  it("warns when active transcript byte guard is inactive without transcript rotation", () => {
    const result = validateConfigObjectWithPlugins(
      {
        agents: {
          defaults: {
            compaction: {
              maxActiveTranscriptBytes: "20mb",
            },
          },
        },
      },
      { pluginValidation: "skip" },
    );

    expect(result.ok).toBe(true);
    expect(result.warnings).toContainEqual({
      path: "agents.defaults.compaction.maxActiveTranscriptBytes",
      message: expect.stringContaining("active-transcript byte guard is inactive"),
    });
  });

  it.each([
    { maxActiveTranscriptBytes: "20mb", truncateAfterCompaction: true },
    { maxActiveTranscriptBytes: 0 },
    { maxActiveTranscriptBytes: "0" },
  ])("does not warn for active or disabled byte guard %#", (compaction) => {
    const result = validateConfigObjectWithPlugins(
      {
        agents: {
          defaults: {
            compaction,
          },
        },
      },
      { pluginValidation: "skip" },
    );

    expect(result.ok).toBe(true);
    expect(result.warnings).not.toContainEqual(
      expect.objectContaining({
        path: "agents.defaults.compaction.maxActiveTranscriptBytes",
      }),
    );
  });
});
