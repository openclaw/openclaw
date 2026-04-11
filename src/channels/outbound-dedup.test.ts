import { afterEach, describe, expect, it, vi } from "vitest";
import { createOutboundDedupGuard, type OutboundDedupGuard } from "./outbound-dedup.js";

describe("outbound dedup guard", () => {
  let guard: OutboundDedupGuard;

  function createGuard(
    overrides?: Partial<{
      windowMs: number;
      maxDuplicates: number;
      pruneIntervalMs: number;
    }>,
  ) {
    guard = createOutboundDedupGuard({
      windowMs: 30_000,
      maxDuplicates: 2,
      pruneIntervalMs: 0, // disable auto-prune in tests
      ...overrides,
    });
    return guard;
  }

  afterEach(() => {
    guard?.dispose();
    vi.useRealTimers();
  });

  // ---------- basic allow/block ----------

  it("allows a message the first time", () => {
    createGuard();
    expect(guard.isDuplicate("hello world")).toBe(false);
  });

  it("allows a message up to maxDuplicates times", () => {
    createGuard({ maxDuplicates: 2 });
    guard.record("hello world");
    expect(guard.isDuplicate("hello world")).toBe(false); // 1 recorded, check for 2nd
  });

  it("flags a message as duplicate once maxDuplicates is exceeded", () => {
    createGuard({ maxDuplicates: 2 });
    guard.record("hello world");
    guard.record("hello world");
    expect(guard.isDuplicate("hello world")).toBe(true);
  });

  // ---------- normalisation ----------

  it("treats messages differing only in whitespace as duplicates", () => {
    createGuard({ maxDuplicates: 1 });
    guard.record("hello world");
    expect(guard.isDuplicate("hello  world")).toBe(true);
  });

  it("treats messages differing only in casing as duplicates", () => {
    createGuard({ maxDuplicates: 1 });
    guard.record("Hello World");
    expect(guard.isDuplicate("hello world")).toBe(true);
  });

  it("does not conflate distinct messages", () => {
    createGuard({ maxDuplicates: 1 });
    guard.record("hello world");
    expect(guard.isDuplicate("goodbye world")).toBe(false);
  });

  // ---------- sliding window ----------

  it("resets duplicate count after the window expires", () => {
    vi.useFakeTimers();
    createGuard({ windowMs: 10_000, maxDuplicates: 2 });
    guard.record("hello world");
    guard.record("hello world");
    expect(guard.isDuplicate("hello world")).toBe(true);

    vi.advanceTimersByTime(11_000); // slide past the window
    expect(guard.isDuplicate("hello world")).toBe(false);
  });

  // ---------- size / prune ----------

  it("size() returns the number of tracked fingerprints", () => {
    createGuard();
    expect(guard.size()).toBe(0);
    guard.record("msg one");
    guard.record("msg two");
    expect(guard.size()).toBe(2);
  });

  it("prune() removes expired fingerprints", () => {
    vi.useFakeTimers();
    createGuard({ windowMs: 5_000 });
    guard.record("msg one");
    expect(guard.size()).toBe(1);

    vi.advanceTimersByTime(6_000);
    guard.prune();
    expect(guard.size()).toBe(0);
  });

  // ---------- dispose ----------

  it("dispose() clears all state", () => {
    createGuard();
    guard.record("msg one");
    guard.dispose();
    expect(guard.size()).toBe(0);
  });
});
