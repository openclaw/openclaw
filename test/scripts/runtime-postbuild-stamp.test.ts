import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeRuntimePostBuildStamp } from "../../scripts/runtime-postbuild-stamp.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

describe("writeRuntimePostBuildStamp (#73151)", () => {
  it("writes dist/.runtime-postbuildstamp with syncedAt and head fields", () => {
    const cwd = createTempDir("openclaw-runtime-postbuild-stamp-");
    const fakeNow = 1_700_000_000_000;
    const fakeSpawnSync = vi.fn(() => ({
      status: 0,
      stdout: "deadbeefcafef00d\n",
    }));
    const stampPath = writeRuntimePostBuildStamp({
      cwd,
      now: () => fakeNow,
      spawnSync: fakeSpawnSync as never,
    });
    expect(stampPath).toBe(path.join(cwd, "dist", ".runtime-postbuildstamp"));
    const written = JSON.parse(fs.readFileSync(stampPath as string, "utf8"));
    expect(written).toEqual({ syncedAt: fakeNow, head: "deadbeefcafef00d" });
  });

  it("omits the head field when git rev-parse fails", () => {
    const cwd = createTempDir("openclaw-runtime-postbuild-stamp-");
    const fakeSpawnSync = vi.fn(() => ({ status: 128, stdout: "" }));
    const stampPath = writeRuntimePostBuildStamp({
      cwd,
      now: () => 42,
      spawnSync: fakeSpawnSync as never,
    });
    const written = JSON.parse(fs.readFileSync(stampPath as string, "utf8"));
    expect(written).toEqual({ syncedAt: 42 });
  });

  it("accepts rootDir as an alias for cwd (matches runtime-postbuild.mjs param shape)", () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-stamp-");
    const fakeSpawnSync = vi.fn(() => ({ status: 0, stdout: "abc\n" }));
    const stampPath = writeRuntimePostBuildStamp({
      rootDir,
      now: () => 100,
      spawnSync: fakeSpawnSync as never,
    });
    expect(stampPath).toBe(path.join(rootDir, "dist", ".runtime-postbuildstamp"));
  });

  it("logs a warning and returns null when the stamp write fails", () => {
    const cwd = createTempDir("openclaw-runtime-postbuild-stamp-");
    const warn = vi.fn();
    const fakeFs = {
      mkdirSync: () => {
        throw new Error("EACCES: simulated");
      },
      writeFileSync: () => {
        throw new Error("should not reach");
      },
    };
    const result = writeRuntimePostBuildStamp({
      cwd,
      fs: fakeFs as never,
      warn,
      now: () => 0,
      spawnSync: vi.fn(() => ({ status: 0, stdout: "" })) as never,
    });
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("EACCES: simulated"));
  });
});
