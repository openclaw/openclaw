import { describe, expect, it } from "vitest";
import {
  CACHED_WORKER_HEAP_FLOOR_MB,
  DEFAULT_WORKER_HEAP_LIMIT_MB,
  MAX_WORKER_HEAP_LIMIT_MB,
  MIN_WORKER_HEAP_LIMIT_MB,
  resolveCachedWorkerHeapLimitMb,
  resolveWorkerHeapLimitMb,
} from "./worker-pool-sizing.js";

describe("resolveWorkerHeapLimitMb", () => {
  it("defaults to the shared per-worker ceiling", () => {
    expect(resolveWorkerHeapLimitMb({})).toBe(DEFAULT_WORKER_HEAP_LIMIT_MB);
  });

  it("keeps the default below the previous hardcoded 512 MiB ceiling", () => {
    expect(DEFAULT_WORKER_HEAP_LIMIT_MB).toBeLessThan(512);
  });

  it("honours an operator override", () => {
    expect(resolveWorkerHeapLimitMb({ OPENCLAW_WORKER_HEAP_LIMIT_MB: "384" })).toBe(384);
  });

  it("clamps an override below the floor", () => {
    expect(resolveWorkerHeapLimitMb({ OPENCLAW_WORKER_HEAP_LIMIT_MB: "1" })).toBe(
      MIN_WORKER_HEAP_LIMIT_MB,
    );
  });

  it("clamps an override above the ceiling", () => {
    expect(resolveWorkerHeapLimitMb({ OPENCLAW_WORKER_HEAP_LIMIT_MB: "999999" })).toBe(
      MAX_WORKER_HEAP_LIMIT_MB,
    );
  });

  it("falls back to the default for an unparseable override", () => {
    expect(resolveWorkerHeapLimitMb({ OPENCLAW_WORKER_HEAP_LIMIT_MB: "not-a-number" })).toBe(
      DEFAULT_WORKER_HEAP_LIMIT_MB,
    );
    expect(resolveWorkerHeapLimitMb({ OPENCLAW_WORKER_HEAP_LIMIT_MB: "  " })).toBe(
      DEFAULT_WORKER_HEAP_LIMIT_MB,
    );
  });
});

describe("resolveCachedWorkerHeapLimitMb", () => {
  it("keeps cached workers on their floor even when the shared default is lower", () => {
    expect(resolveCachedWorkerHeapLimitMb({})).toBe(CACHED_WORKER_HEAP_FLOOR_MB);
  });

  it("never lowers a cached worker below the floor", () => {
    expect(resolveCachedWorkerHeapLimitMb({ OPENCLAW_WORKER_HEAP_LIMIT_MB: "128" })).toBe(
      CACHED_WORKER_HEAP_FLOOR_MB,
    );
  });

  it("raises a cached worker when the operator asks for more", () => {
    expect(resolveCachedWorkerHeapLimitMb({ OPENCLAW_WORKER_HEAP_LIMIT_MB: "1024" })).toBe(1024);
  });
});
