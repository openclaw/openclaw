// Tests for the process-scoped fs.existsSync cache.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSyncCached, invalidateExistsSyncCache } from "./cached-fs.js";

describe("existsSyncCached", () => {
  afterEach(() => {
    invalidateExistsSyncCache();
  });

  it("returns the same result as fs.existsSync", () => {
    const existingPath = path.resolve(".");
    expect(existsSyncCached(existingPath)).toBe(fs.existsSync(existingPath));
  });

  it("returns false for a non-existent path", () => {
    const missing = path.join(path.resolve("."), "definitely-does-not-exist-12345");
    expect(existsSyncCached(missing)).toBe(false);
  });

  it("caches repeated lookups so fs.existsSync is called only once per path", () => {
    const spy = vi.spyOn(fs, "existsSync");
    const testPath = "/test/cached/path";
    spy.mockClear();

    // First call hits fs.existsSync.
    existsSyncCached(testPath);
    expect(spy).toHaveBeenCalledTimes(1);

    // Second call should use cache.
    existsSyncCached(testPath);
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });

  it("returns cached false for non-existent paths", () => {
    const spy = vi.spyOn(fs, "existsSync");
    const missing = "/no/such/path/12345";
    spy.mockClear();

    existsSyncCached(missing);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(existsSyncCached(missing)).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });
});

describe("invalidateExistsSyncCache", () => {
  afterEach(() => {
    invalidateExistsSyncCache();
  });

  it("clears the cache for a specific path", () => {
    const spy = vi.spyOn(fs, "existsSync");
    const testPath = "/test/specific/path";
    spy.mockClear();

    existsSyncCached(testPath);
    expect(spy).toHaveBeenCalledTimes(1);

    invalidateExistsSyncCache(testPath);
    existsSyncCached(testPath);
    expect(spy).toHaveBeenCalledTimes(2);

    spy.mockRestore();
  });

  it("clears the entire cache when called with no argument", () => {
    const spy = vi.spyOn(fs, "existsSync");
    const pathA = "/test/path/a";
    const pathB = "/test/path/b";
    spy.mockClear();

    existsSyncCached(pathA);
    existsSyncCached(pathB);
    expect(spy).toHaveBeenCalledTimes(2);

    invalidateExistsSyncCache();
    existsSyncCached(pathA);
    existsSyncCached(pathB);
    expect(spy).toHaveBeenCalledTimes(4);

    spy.mockRestore();
  });
});
