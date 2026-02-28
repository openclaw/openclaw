import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  MEMORY_FLUSH_COOLDOWN_MS,
  resolveMemoryFlushPromptForRun,
  shouldRunMemoryFlush,
} from "./memory-flush.js";

describe("resolveMemoryFlushPromptForRun", () => {
  const cfg = {
    agents: {
      defaults: {
        userTimezone: "America/New_York",
        timeFormat: "12",
      },
    },
  } as OpenClawConfig;

  it("replaces YYYY-MM-DD using user timezone and appends current time", () => {
    const prompt = resolveMemoryFlushPromptForRun({
      prompt: "Store durable notes in memory/YYYY-MM-DD.md",
      cfg,
      nowMs: Date.UTC(2026, 1, 16, 15, 0, 0),
    });

    expect(prompt).toContain("memory/2026-02-16.md");
    expect(prompt).toContain("Current time:");
    expect(prompt).toContain("(America/New_York)");
  });

  it("does not append a duplicate current time line", () => {
    const prompt = resolveMemoryFlushPromptForRun({
      prompt: "Store notes.\nCurrent time: already present",
      cfg,
      nowMs: Date.UTC(2026, 1, 16, 15, 0, 0),
    });

    expect(prompt).toContain("Current time: already present");
    expect((prompt.match(/Current time:/g) ?? []).length).toBe(1);
  });
});

describe("shouldRunMemoryFlush", () => {
  const baseParams = {
    contextWindowTokens: 200_000,
    reserveTokensFloor: 10_000,
    softThresholdTokens: 5_000,
  };
  const aboveThreshold = { totalTokens: 190_000, totalTokensFresh: true as const };

  it("returns true when above threshold and no prior flush", () => {
    expect(
      shouldRunMemoryFlush({
        ...baseParams,
        entry: { ...aboveThreshold, compactionCount: 1 },
      }),
    ).toBe(true);
  });

  it("returns false when tokens are below threshold", () => {
    expect(
      shouldRunMemoryFlush({
        ...baseParams,
        entry: { totalTokens: 100_000, totalTokensFresh: true, compactionCount: 1 },
      }),
    ).toBe(false);
  });

  it("returns false when compaction-count dedup matches", () => {
    expect(
      shouldRunMemoryFlush({
        ...baseParams,
        entry: { ...aboveThreshold, compactionCount: 3, memoryFlushCompactionCount: 3 },
      }),
    ).toBe(false);
  });

  it("returns false within cooldown period", () => {
    expect(
      shouldRunMemoryFlush({
        ...baseParams,
        entry: {
          ...aboveThreshold,
          compactionCount: 2,
          memoryFlushCompactionCount: 1,
          memoryFlushAt: 1000,
        },
        nowMs: 1000 + MEMORY_FLUSH_COOLDOWN_MS - 1,
      }),
    ).toBe(false);
  });

  it("returns true after cooldown expires", () => {
    expect(
      shouldRunMemoryFlush({
        ...baseParams,
        entry: {
          ...aboveThreshold,
          compactionCount: 2,
          memoryFlushCompactionCount: 1,
          memoryFlushAt: 1000,
        },
        nowMs: 1000 + MEMORY_FLUSH_COOLDOWN_MS + 1,
      }),
    ).toBe(true);
  });
});
