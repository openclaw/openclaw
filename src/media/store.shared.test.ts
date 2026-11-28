import { describe, expect, it } from "vitest";
import { FsSafeError } from "../infra/fs-safe.js";
import { ImageOptimizationLimitError } from "./image-optimization-error.js";
import { readMediaSizeFacts, SaveMediaSourceError } from "./store.shared.js";

describe("SaveMediaSourceError.tooLarge", () => {
  it("names the limit and, when known, the rejected size", () => {
    expect(SaveMediaSourceError.tooLarge(5 * 1024 * 1024, { sizeBytes: 6_000_000 }).message).toBe(
      "Media exceeds 5MB limit (got 5.72MB)",
    );
    expect(SaveMediaSourceError.tooLarge(1024).message).toBe("Media exceeds 1KB limit");
  });

  it("ignores byte counts that are not whole non-negative numbers", () => {
    const error = new SaveMediaSourceError("too-large", "too large", {
      sizeBytes: Number.NaN,
      maxBytes: -1,
    });
    expect(error.sizeBytes).toBeUndefined();
    expect(error.maxBytes).toBeUndefined();
  });
});

describe("readMediaSizeFacts", () => {
  it("reads size and limit from media errors", () => {
    expect(readMediaSizeFacts(SaveMediaSourceError.tooLarge(10, { sizeBytes: 11 }))).toEqual({
      sizeBytes: 11,
      maxBytes: 10,
    });
    expect(readMediaSizeFacts(new ImageOptimizationLimitError("too big", 10, 40))).toEqual({
      sizeBytes: 40,
      maxBytes: 10,
    });
  });

  it("reads fs-safe details through wrapping errors", () => {
    const fsError = new FsSafeError("too-large", "file exceeds limit", {
      details: { sizeBytes: 9_000, maxBytes: 4_096 },
    });
    const wrapped = new Error("Media exceeds 4KB limit", { cause: fsError });
    expect(readMediaSizeFacts(wrapped)).toEqual({ sizeBytes: 9_000, maxBytes: 4_096 });
  });

  it("combines facts recorded at different layers, preferring the outermost", () => {
    const inner = new FsSafeError("too-large", "file exceeds limit", {
      details: { sizeBytes: 9_000, maxBytes: 1 },
    });
    const outer = SaveMediaSourceError.tooLarge(4_096, { cause: inner });
    expect(readMediaSizeFacts(outer)).toEqual({ sizeBytes: 9_000, maxBytes: 4_096 });
  });

  it("returns nothing for errors without byte facts and stops on cause cycles", () => {
    expect(readMediaSizeFacts(new Error("nope"))).toEqual({});
    expect(readMediaSizeFacts("not an error")).toEqual({});
    const loop = new Error("loop");
    (loop as Error & { cause?: unknown }).cause = loop;
    expect(readMediaSizeFacts(loop)).toEqual({});
  });
});
