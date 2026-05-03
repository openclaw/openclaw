import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSyncCached, invalidateExistsSyncCache } from "./cached-fs.js";

describe("existsSyncCached", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cached-fs-"));
    invalidateExistsSyncCache();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    invalidateExistsSyncCache();
  });

  it("returns true for a path that exists and false for one that does not", () => {
    const present = path.join(tmpDir, "present");
    const missing = path.join(tmpDir, "missing");
    fs.writeFileSync(present, "x");
    expect(existsSyncCached(present)).toBe(true);
    expect(existsSyncCached(missing)).toBe(false);
  });

  it("memoizes the result so a follow-up call does not hit the disk", () => {
    const target = path.join(tmpDir, "target");
    fs.writeFileSync(target, "x");
    expect(existsSyncCached(target)).toBe(true);

    const spy = vi.spyOn(fs, "existsSync");
    expect(existsSyncCached(target)).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("invalidateExistsSyncCache(path) drops a single entry", () => {
    const target = path.join(tmpDir, "target");
    expect(existsSyncCached(target)).toBe(false);
    fs.writeFileSync(target, "x");
    // Stale cached result until invalidation.
    expect(existsSyncCached(target)).toBe(false);
    invalidateExistsSyncCache(target);
    expect(existsSyncCached(target)).toBe(true);
  });

  it("invalidateExistsSyncCache() clears every entry", () => {
    const a = path.join(tmpDir, "a");
    const b = path.join(tmpDir, "b");
    expect(existsSyncCached(a)).toBe(false);
    expect(existsSyncCached(b)).toBe(false);
    fs.writeFileSync(a, "x");
    fs.writeFileSync(b, "x");
    expect(existsSyncCached(a)).toBe(false);
    expect(existsSyncCached(b)).toBe(false);
    invalidateExistsSyncCache();
    expect(existsSyncCached(a)).toBe(true);
    expect(existsSyncCached(b)).toBe(true);
  });
});
