import { describe, expect, it } from "vitest";
import { shouldRunEmbeddedPreAttemptMemoryFlush } from "./memory-flush.js";

describe("embedded pre-attempt memory flush gating", () => {
  const base = {
    trigger: "message",
    entry: {
      totalTokens: 9_200,
      totalTokensFresh: true,
      compactionCount: 2,
    },
    contextWindowTokens: 10_000,
    reserveTokensFloor: 500,
    softThresholdTokens: 500,
  } as const;

  it("runs before an embedded attempt when projected tokens cross the memory-flush threshold", () => {
    expect(shouldRunEmbeddedPreAttemptMemoryFlush(base)).toBe(true);
  });

  it("does not recurse into memory-triggered flush attempts", () => {
    expect(
      shouldRunEmbeddedPreAttemptMemoryFlush({
        ...base,
        trigger: "memory",
      }),
    ).toBe(false);
  });

  it("only attempts once per outer embedded run", () => {
    expect(
      shouldRunEmbeddedPreAttemptMemoryFlush({
        ...base,
        attemptedThisRun: true,
      }),
    ).toBe(false);
  });

  it("does not rerun after the current compaction cycle already flushed", () => {
    expect(
      shouldRunEmbeddedPreAttemptMemoryFlush({
        ...base,
        entry: {
          ...base.entry,
          memoryFlushCompactionCount: 2,
        },
      }),
    ).toBe(false);
  });

  it("supports transcript-size forced flushes without requiring a fresh token count", () => {
    expect(
      shouldRunEmbeddedPreAttemptMemoryFlush({
        ...base,
        entry: {
          compactionCount: 3,
          totalTokensFresh: false,
        },
        forceFlushByTranscriptSize: true,
      }),
    ).toBe(true);
  });

  it("respects disabled and unwritable flush state", () => {
    expect(
      shouldRunEmbeddedPreAttemptMemoryFlush({
        ...base,
        memoryFlushEnabled: false,
      }),
    ).toBe(false);
    expect(
      shouldRunEmbeddedPreAttemptMemoryFlush({
        ...base,
        memoryFlushWritable: false,
      }),
    ).toBe(false);
  });
});
