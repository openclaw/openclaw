import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateRuntimeEligibility, hasBinary } from "./config-eval.js";

describe("evaluateRuntimeEligibility", () => {
  it("rejects entries when required OS does not match local or remote", () => {
    const result = evaluateRuntimeEligibility({
      os: ["definitely-not-a-runtime-platform"],
      remotePlatforms: [],
      hasBin: () => true,
      hasEnv: () => true,
      isConfigPathTruthy: () => true,
    });
    expect(result).toBe(false);
  });

  it("accepts entries when remote platform satisfies OS requirements", () => {
    const result = evaluateRuntimeEligibility({
      os: ["linux"],
      remotePlatforms: ["linux"],
      hasBin: () => true,
      hasEnv: () => true,
      isConfigPathTruthy: () => true,
    });
    expect(result).toBe(true);
  });

  it("bypasses runtime requirements when always=true", () => {
    const result = evaluateRuntimeEligibility({
      always: true,
      requires: { env: ["OPENAI_API_KEY"] },
      hasBin: () => false,
      hasEnv: () => false,
      isConfigPathTruthy: () => false,
    });
    expect(result).toBe(true);
  });

  it("evaluates runtime requirements when always is false", () => {
    const result = evaluateRuntimeEligibility({
      requires: {
        bins: ["node"],
        anyBins: ["bun", "node"],
        env: ["OPENAI_API_KEY"],
        config: ["browser.enabled"],
      },
      hasBin: (bin) => bin === "node",
      hasAnyRemoteBin: () => false,
      hasEnv: (name) => name === "OPENAI_API_KEY",
      isConfigPathTruthy: (path) => path === "browser.enabled",
    });
    expect(result).toBe(true);
  });
});

describe("hasBinary", () => {
  const originalPath = process.env.PATH;
  const originalPathext = process.env.PATHEXT;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.PATH = `/tmp/config-eval-bin-${Date.now()}`;
    process.env.PATHEXT = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.PATH = originalPath;
    if (originalPathext === undefined) {
      delete process.env.PATHEXT;
    } else {
      process.env.PATHEXT = originalPathext;
    }
  });

  it("reuses cached lookup results for the same binary", () => {
    const accessSpy = vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });

    expect(hasBinary("cache-hit-bin")).toBe(false);
    expect(hasBinary("cache-hit-bin")).toBe(false);
    expect(accessSpy).toHaveBeenCalledTimes(1);
  });

  it("evicts oldest entries once the cache cap is exceeded", () => {
    const accessSpy = vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });

    for (let i = 0; i < 300; i += 1) {
      expect(hasBinary(`bin-${i}`)).toBe(false);
    }

    const callsAfterWarmup = accessSpy.mock.calls.length;
    expect(hasBinary("bin-0")).toBe(false);
    expect(accessSpy).toHaveBeenCalledTimes(callsAfterWarmup + 1);

    expect(hasBinary("bin-299")).toBe(false);
    expect(accessSpy).toHaveBeenCalledTimes(callsAfterWarmup + 1);
  });
});
