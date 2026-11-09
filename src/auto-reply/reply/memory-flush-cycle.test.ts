import { describe, expect, it } from "vitest";
import {
  CLI_MEMORY_FLUSH_REARM_BYTES,
  hasAlreadyFlushedForCliRearmBucket,
  resolveCliMemoryFlushRearmBucket,
  byteTrigger,
} from "./memory-flush-cycle.js";

describe("CLI memory-flush re-arm window", () => {
  it("buckets CLI transcript growth and leaves other backends on the compaction watermark", () => {
    expect(
      resolveCliMemoryFlushRearmBucket({ isCli: false, transcriptByteSize: 10 }),
    ).toBeUndefined();
    expect(resolveCliMemoryFlushRearmBucket({ isCli: true })).toBeUndefined();
    expect(
      resolveCliMemoryFlushRearmBucket({ isCli: true, transcriptByteSize: Number.NaN }),
    ).toBeUndefined();
    expect(
      resolveCliMemoryFlushRearmBucket({ isCli: true, transcriptByteSize: 10, rearmBytes: 0 }),
    ).toBeUndefined();
    expect(resolveCliMemoryFlushRearmBucket({ isCli: true, transcriptByteSize: 0 })).toBe(0);
    expect(
      resolveCliMemoryFlushRearmBucket({
        isCli: true,
        transcriptByteSize: CLI_MEMORY_FLUSH_REARM_BYTES * 3 + 1,
      }),
    ).toBe(3);
  });

  it("suppresses only a succeeded record for the same bucket", () => {
    const bucket = resolveCliMemoryFlushRearmBucket({
      isCli: true,
      transcriptByteSize: CLI_MEMORY_FLUSH_REARM_BYTES * 2,
    });
    if (bucket === undefined) {
      throw new Error("expected a CLI re-arm bucket");
    }
    const succeeded = {
      memoryFlush: { kind: "succeeded" as const, compactionCount: 0, cliRearmBucket: bucket },
    };
    expect(hasAlreadyFlushedForCliRearmBucket(succeeded, bucket)).toBe(true);
    expect(hasAlreadyFlushedForCliRearmBucket(succeeded, bucket + 1)).toBe(false);
    expect(
      hasAlreadyFlushedForCliRearmBucket(
        { memoryFlush: { kind: "failed", cliRearmBucket: bucket, failureCount: 1 } },
        bucket,
      ),
    ).toBe(false);
    // Rows written before the bucket existed never suppress.
    expect(
      hasAlreadyFlushedForCliRearmBucket(
        { memoryFlush: { kind: "succeeded", compactionCount: 0 } },
        bucket,
      ),
    ).toBe(false);
    expect(hasAlreadyFlushedForCliRearmBucket(undefined, bucket)).toBe(false);
  });
});

describe("byteTrigger", () => {
  const entry = {};
  const trigger = (
    isCli: boolean,
    byteSize: number | undefined,
    forceFlushTranscriptBytes: number,
  ) =>
    byteTrigger({
      isCli,
      entry,
      sessionLogSnapshot: { byteSize },
      memoryFlushPlan: { forceFlushTranscriptBytes },
    });

  it("keeps byte forcing off at a zero threshold even when CLI reads the size", () => {
    expect(trigger(true, 512, 0)).toEqual({ skip: false, forced: false, cliRearmBucket: 0 });
  });

  it("forces non-CLI sessions over the byte threshold without a bucket", () => {
    expect(trigger(false, 512, 100)).toEqual({ skip: false, forced: true });
  });

  it("skips CLI sessions without a transcript size", () => {
    expect(trigger(true, undefined, 100)).toMatchObject({ skip: true });
  });
});
