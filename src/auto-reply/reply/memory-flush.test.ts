import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEMORY_FLUSH_SOFT_TOKENS,
  DEFAULT_MIN_TOKENS_FOR_FLUSH,
  resolveMemoryFlushContextWindowTokens,
  resolveMemoryFlushSettings,
  shouldRunMemoryFlush,
  shouldRunMemoryFlushCheckpoint,
  shouldRunBeforeClearFlush,
} from "./memory-flush.js";

describe("memory flush settings", () => {
  it("defaults to enabled with fallback prompt and system prompt", () => {
    const settings = resolveMemoryFlushSettings();
    expect(settings).not.toBeNull();
    expect(settings?.enabled).toBe(true);
    expect(settings?.prompt.length).toBeGreaterThan(0);
    expect(settings?.systemPrompt.length).toBeGreaterThan(0);
  });

  it("respects disable flag", () => {
    expect(
      resolveMemoryFlushSettings({
        agents: {
          defaults: { compaction: { memoryFlush: { enabled: false } } },
        },
      }),
    ).toBeNull();
  });

  it("appends NO_REPLY hint when missing", () => {
    const settings = resolveMemoryFlushSettings({
      agents: {
        defaults: {
          compaction: {
            memoryFlush: {
              prompt: "Write memories now.",
              systemPrompt: "Flush memory.",
            },
          },
        },
      },
    });
    expect(settings?.prompt).toContain("NO_REPLY");
    expect(settings?.systemPrompt).toContain("NO_REPLY");
  });
});

describe("shouldRunMemoryFlush", () => {
  it("requires totalTokens and threshold", () => {
    expect(
      shouldRunMemoryFlush({
        entry: { totalTokens: 0 },
        contextWindowTokens: 16_000,
        reserveTokensFloor: 20_000,
        softThresholdTokens: DEFAULT_MEMORY_FLUSH_SOFT_TOKENS,
      }),
    ).toBe(false);
  });

  it("skips when entry is missing", () => {
    expect(
      shouldRunMemoryFlush({
        entry: undefined,
        contextWindowTokens: 16_000,
        reserveTokensFloor: 1_000,
        softThresholdTokens: DEFAULT_MEMORY_FLUSH_SOFT_TOKENS,
      }),
    ).toBe(false);
  });

  it("skips when under threshold", () => {
    expect(
      shouldRunMemoryFlush({
        entry: { totalTokens: 10_000 },
        contextWindowTokens: 100_000,
        reserveTokensFloor: 20_000,
        softThresholdTokens: 10_000,
      }),
    ).toBe(false);
  });

  it("triggers at the threshold boundary", () => {
    expect(
      shouldRunMemoryFlush({
        entry: { totalTokens: 85 },
        contextWindowTokens: 100,
        reserveTokensFloor: 10,
        softThresholdTokens: 5,
      }),
    ).toBe(true);
  });

  it("skips when already flushed for current compaction count", () => {
    expect(
      shouldRunMemoryFlush({
        entry: {
          totalTokens: 90_000,
          compactionCount: 2,
          memoryFlushCompactionCount: 2,
        },
        contextWindowTokens: 100_000,
        reserveTokensFloor: 5_000,
        softThresholdTokens: 2_000,
      }),
    ).toBe(false);
  });

  it("runs when above threshold and not flushed", () => {
    expect(
      shouldRunMemoryFlush({
        entry: { totalTokens: 96_000, compactionCount: 1 },
        contextWindowTokens: 100_000,
        reserveTokensFloor: 5_000,
        softThresholdTokens: 2_000,
      }),
    ).toBe(true);
  });
});

describe("resolveMemoryFlushContextWindowTokens", () => {
  it("falls back to agent config or default tokens", () => {
    expect(resolveMemoryFlushContextWindowTokens({ agentCfgContextTokens: 42_000 })).toBe(42_000);
  });
});

describe("checkpoint memory flush", () => {
  describe("resolveMemoryFlushSettings with checkpoints", () => {
    it("parses and sorts checkpoints by percent ascending", () => {
      const settings = resolveMemoryFlushSettings({
        agents: {
          defaults: {
            compaction: {
              memoryFlush: {
                checkpoints: [
                  { percent: 80, prompt: "80% prompt" },
                  { percent: 20, prompt: "20% prompt" },
                  { percent: 40, prompt: "40% prompt" },
                ],
              },
            },
          },
        },
      });
      expect(settings?.checkpoints).toHaveLength(3);
      expect(settings?.checkpoints?.[0].percent).toBe(20);
      expect(settings?.checkpoints?.[1].percent).toBe(40);
      expect(settings?.checkpoints?.[2].percent).toBe(80);
    });

    it("handles checkpoints with optional prompts and systemPrompts", () => {
      const settings = resolveMemoryFlushSettings({
        agents: {
          defaults: {
            compaction: {
              memoryFlush: {
                checkpoints: [
                  { percent: 50 },
                  { percent: 75, systemPrompt: "Custom system prompt" },
                ],
              },
            },
          },
        },
      });
      expect(settings?.checkpoints?.[0].prompt).toBeUndefined();
      expect(settings?.checkpoints?.[1].systemPrompt).toBe("Custom system prompt");
    });

    it("ignores non-numeric/NaN checkpoints and clamps out-of-range percents", () => {
      const settings = resolveMemoryFlushSettings({
        agents: {
          defaults: {
            compaction: {
              memoryFlush: {
                checkpoints: [
                  { percent: 50 },
                  { percent: "invalid" as unknown as number },
                  { percent: Number.NaN },
                  null as unknown as { percent: number },
                  { percent: 0 },
                  { percent: 75 },
                  { percent: 200 },
                ],
              },
            },
          },
        },
      });

      // 0 -> 1, 200 -> 99; invalid + NaN + null dropped.
      expect(settings?.checkpoints).toHaveLength(4);
      expect(settings?.checkpoints?.map((c) => c.percent)).toEqual([1, 50, 75, 99]);
    });
  });

  describe("shouldRunMemoryFlushCheckpoint", () => {
    it("fires at correct percentage", () => {
      const result = shouldRunMemoryFlushCheckpoint({
        entry: { totalTokens: 50_000 },
        contextWindowTokens: 100_000,
        checkpoints: [{ percent: 40 }, { percent: 60 }],
      });
      expect(result.shouldRun).toBe(true);
      expect(result.checkpoint?.percent).toBe(40);
      expect(result.percent).toBeCloseTo(50, 0);
    });

    it("fires highest applicable unfired checkpoint", () => {
      const result = shouldRunMemoryFlushCheckpoint({
        entry: { totalTokens: 85_000, memoryFlushCheckpointsFired: [40, 60] },
        contextWindowTokens: 100_000,
        checkpoints: [{ percent: 40 }, { percent: 60 }, { percent: 80 }],
      });
      expect(result.shouldRun).toBe(true);
      expect(result.checkpoint?.percent).toBe(80);
    });

    it("does not re-fire already-fired checkpoints", () => {
      const result = shouldRunMemoryFlushCheckpoint({
        entry: { totalTokens: 85_000, memoryFlushCheckpointsFired: [40, 60, 80] },
        contextWindowTokens: 100_000,
        checkpoints: [{ percent: 40 }, { percent: 60 }, { percent: 80 }],
      });
      expect(result.shouldRun).toBe(false);
    });

    it("does not fire when below all checkpoints", () => {
      const result = shouldRunMemoryFlushCheckpoint({
        entry: { totalTokens: 15_000 },
        contextWindowTokens: 100_000,
        checkpoints: [{ percent: 20 }, { percent: 40 }],
      });
      expect(result.shouldRun).toBe(false);
    });

    it("handles missing totalTokens", () => {
      const result = shouldRunMemoryFlushCheckpoint({
        entry: { totalTokens: 0 },
        contextWindowTokens: 100_000,
        checkpoints: [{ percent: 20 }],
      });
      expect(result.shouldRun).toBe(false);
    });

    it("handles missing checkpoints", () => {
      const result = shouldRunMemoryFlushCheckpoint({
        entry: { totalTokens: 50_000 },
        contextWindowTokens: 100_000,
        checkpoints: undefined,
      });
      expect(result.shouldRun).toBe(false);
    });

    it("handles empty checkpoints array", () => {
      const result = shouldRunMemoryFlushCheckpoint({
        entry: { totalTokens: 50_000 },
        contextWindowTokens: 100_000,
        checkpoints: [],
      });
      expect(result.shouldRun).toBe(false);
    });
  });

  describe("backward compatibility", () => {
    it("existing softThresholdTokens behavior unchanged when no checkpoints", () => {
      const settings = resolveMemoryFlushSettings({
        agents: {
          defaults: {
            compaction: {
              memoryFlush: {
                enabled: true,
                softThresholdTokens: 5000,
              },
            },
          },
        },
      });
      expect(settings?.enabled).toBe(true);
      expect(settings?.softThresholdTokens).toBe(5000);
      expect(settings?.checkpoints).toBeUndefined();
    });
  });
});

describe("beforeClear memory flush settings", () => {
  it("defaults to enabled with default prompts and minTokens", () => {
    const settings = resolveMemoryFlushSettings();
    expect(settings).not.toBeNull();
    expect(settings?.beforeClear).toBe(true);
    expect(settings?.minTokensForFlush).toBe(DEFAULT_MIN_TOKENS_FOR_FLUSH);
    expect(settings?.beforeClearPrompt.length).toBeGreaterThan(0);
    expect(settings?.beforeClearSystemPrompt.length).toBeGreaterThan(0);
  });

  it("respects custom beforeClear settings", () => {
    const settings = resolveMemoryFlushSettings({
      agents: {
        defaults: {
          compaction: {
            memoryFlush: {
              beforeClear: false,
              minTokensForFlush: 2000,
              beforeClearPrompt: "Custom pre-clear prompt",
              beforeClearSystemPrompt: "Custom pre-clear system",
            },
          },
        },
      },
    });
    expect(settings?.beforeClear).toBe(false);
    expect(settings?.minTokensForFlush).toBe(2000);
    expect(settings?.beforeClearPrompt).toContain("Custom pre-clear prompt");
    expect(settings?.beforeClearSystemPrompt).toContain("Custom pre-clear system");
  });

  it("appends NO_REPLY hint to beforeClear prompts when missing", () => {
    const settings = resolveMemoryFlushSettings({
      agents: {
        defaults: {
          compaction: {
            memoryFlush: {
              beforeClearPrompt: "Store context now.",
              beforeClearSystemPrompt: "Pre-clear flush.",
            },
          },
        },
      },
    });
    expect(settings?.beforeClearPrompt).toContain("NO_REPLY");
    expect(settings?.beforeClearSystemPrompt).toContain("NO_REPLY");
  });
});

describe("shouldRunBeforeClearFlush", () => {
  it("requires totalTokens above minTokensForFlush", () => {
    expect(
      shouldRunBeforeClearFlush({
        entry: { totalTokens: 500 },
        minTokensForFlush: 1000,
      }),
    ).toBe(false);
  });

  it("skips when entry is missing", () => {
    expect(
      shouldRunBeforeClearFlush({
        entry: undefined,
        minTokensForFlush: 1000,
      }),
    ).toBe(false);
  });

  it("skips when totalTokens is zero", () => {
    expect(
      shouldRunBeforeClearFlush({
        entry: { totalTokens: 0 },
        minTokensForFlush: 1000,
      }),
    ).toBe(false);
  });

  it("triggers when totalTokens >= minTokensForFlush", () => {
    expect(
      shouldRunBeforeClearFlush({
        entry: { totalTokens: 1000 },
        minTokensForFlush: 1000,
      }),
    ).toBe(true);

    expect(
      shouldRunBeforeClearFlush({
        entry: { totalTokens: 5000 },
        minTokensForFlush: 1000,
      }),
    ).toBe(true);
  });

  it("handles edge case of minTokensForFlush = 0", () => {
    expect(
      shouldRunBeforeClearFlush({
        entry: { totalTokens: 1 },
        minTokensForFlush: 0,
      }),
    ).toBe(true);
  });
});
