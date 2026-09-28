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
