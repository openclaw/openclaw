// Verifies compaction settings config parsing and defaults.
import { describe, expect, it } from "vitest";
import { applyCompactionDefaults } from "./defaults.js";
import type { OpenClawConfig } from "./types.js";

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
  it("preserves explicit compaction mode and settings", () => {
    const compaction = {
      mode: "default",
      memoryFlush: {
        enabled: false,
        model: "ollama/qwen3:8b",
        softThresholdTokens: 1234,
      },
      maxActiveTranscriptBytes: "20mb",
    } as const;
    expect(materializeCompactionConfig(compaction)).toEqual(compaction);
  });

  it("preserves safeguard semantic observation settings alongside memory flush", () => {
    const compaction = materializeCompactionConfig({
      mode: "safeguard",
      identifierPolicy: "strict",
      qualityGuard: { enabled: true, maxRetries: 2 },
      semanticCuration: { mode: "shadow", timeoutMs: 600 },
      midTurnPrecheck: { enabled: true },
      memoryFlush: {
        enabled: false,
        model: "ollama/qwen3:8b",
        softThresholdTokens: 1234,
      },
      maxActiveTranscriptBytes: "20mb",
    });

    expect(compaction?.mode).toBe("safeguard");
    expect(compaction?.keepRecentTokens).toBeUndefined();
    expect(compaction?.identifierPolicy).toBe("strict");
    expect(compaction?.qualityGuard?.enabled).toBe(true);
    expect(compaction?.qualityGuard?.maxRetries).toBe(2);
    expect(compaction?.semanticCuration?.mode).toBe("shadow");
    expect(compaction?.semanticCuration?.timeoutMs).toBe(600);
    expect(compaction?.midTurnPrecheck?.enabled).toBe(true);
    expect(compaction?.memoryFlush?.enabled).toBe(false);
    expect(compaction?.memoryFlush?.model).toBe("ollama/qwen3:8b");
    expect(compaction?.memoryFlush?.softThresholdTokens).toBe(1234);
    expect(compaction?.maxActiveTranscriptBytes).toBe("20mb");
  });

  it("defaults compaction mode to safeguard", () => {
    const compaction = materializeCompactionConfig({});

    expect(compaction?.mode).toBe("safeguard");
  });

  it("preserves authored settings while supplying the missing mode", () => {
    const compaction = {
      thinkingLevel: "inherit",
      qualityGuard: {
        maxRetries: 99,
      },
    } as const;
    expect(materializeCompactionConfig(compaction)).toEqual({ ...compaction, mode: "safeguard" });
  });
});
