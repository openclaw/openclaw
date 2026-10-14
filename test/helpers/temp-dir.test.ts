import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveNativeFixtureShortPath } from "../scripts/native-boundary-fixture.js";
import { cleanupTempDirs, makeTempDir } from "./temp-dir.js";

const tempDirs = new Set<string>();

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

describe("temp-dir test helpers", () => {
  it.each(["array", "set"] as const)(
    "continues after a failed removal and retains the failed directory in its %s",
    (collection) => {
      const dirs = collection === "array" ? [] : new Set<string>();
      const failed = makeTempDir(dirs, "openclaw-temp-dir-failed-");
      const other = makeTempDir(dirs, "openclaw-temp-dir-other-");
      tempDirs.add(failed);
      tempDirs.add(other);
      const failure = new Error("injected directory removal failure");
      const rmSync = fs.rmSync.bind(fs);
      const remove = vi.spyOn(fs, "rmSync").mockImplementation((dir, options) => {
        if (dir === failed) {
          throw failure;
        }
        rmSync(dir, options);
      });
      try {
        expect(() => cleanupTempDirs(dirs)).toThrow(failure);
        expect(fs.existsSync(other)).toBe(false);
        expect([...dirs]).toEqual([failed]);
      } finally {
        remove.mockRestore();
        cleanupTempDirs(dirs);
      }
    },
  );

  it("reports every failed removal while still releasing the remaining directories", () => {
    const dirs = new Set<string>();
    const first = makeTempDir(dirs, "openclaw-temp-dir-first-failed-");
    const second = makeTempDir(dirs, "openclaw-temp-dir-second-failed-");
    const other = makeTempDir(dirs, "openclaw-temp-dir-success-");
    for (const dir of dirs) {
      tempDirs.add(dir);
    }
    const failures = new Map([
      [first, new Error("first removal failed")],
      [second, new Error("second removal failed")],
    ]);
    const rmSync = fs.rmSync.bind(fs);
    const remove = vi.spyOn(fs, "rmSync").mockImplementation((dir, options) => {
      const failure = failures.get(String(dir));
      if (failure) {
        throw failure;
      }
      rmSync(dir, options);
    });
    try {
      let failure: unknown;
      try {
        cleanupTempDirs(dirs);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([...failures.values()]);
      expect(fs.existsSync(other)).toBe(false);
      expect([...dirs]).toEqual([first, second]);
    } finally {
      remove.mockRestore();
      cleanupTempDirs(dirs);
    }
  });

  it.skipIf(process.platform !== "win32")(
    "expands short names in default temp roots",
    ({ skip }) => {
      const root = makeTempDir(tempDirs, "openclaw-temp-dir-short-name-");
      const shortRoot = resolveNativeFixtureShortPath(root);
      if (!shortRoot) {
        skip();
        return;
      }
      const tmpdir = vi.spyOn(os, "tmpdir").mockReturnValue(shortRoot);
      try {
        const dir = makeTempDir(tempDirs, "child-");
        expect(path.dirname(dir)).toBe(fs.realpathSync.native(root));
      } finally {
        tmpdir.mockRestore();
      }
    },
  );
});
