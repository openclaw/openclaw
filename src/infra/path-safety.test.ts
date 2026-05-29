// Covers safe base-dir and containment checks.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  isPathInsideWithRealpath,
  isWithinDir,
  resolveSafeBaseDir,
  safeRealpathSync,
} from "./path-safety.js";

describe("path-safety", () => {
  it.each([
    { rootDir: "/tmp/demo", expected: `${path.resolve("/tmp/demo")}${path.sep}` },
    { rootDir: `/tmp/demo${path.sep}`, expected: `${path.resolve("/tmp/demo")}${path.sep}` },
    { rootDir: "/tmp/demo/..", expected: `${path.resolve("/tmp")}${path.sep}` },
  ])("resolves safe base dir for %j", ({ rootDir, expected }) => {
    expect(resolveSafeBaseDir(rootDir)).toBe(expected);
  });

  it.each([
    { rootDir: "/tmp/demo", targetPath: "/tmp/demo", expected: true },
    { rootDir: "/tmp/demo", targetPath: "/tmp/demo/sub/file.txt", expected: true },
    { rootDir: "/tmp/demo", targetPath: "/tmp/demo/./nested/../file.txt", expected: true },
    { rootDir: "/tmp/demo", targetPath: "/tmp/demo-two/../demo/file.txt", expected: true },
    { rootDir: "/tmp/demo", targetPath: "/tmp/demo/../escape.txt", expected: false },
    { rootDir: "/tmp/demo", targetPath: "/tmp/demo-sibling/file.txt", expected: false },
    { rootDir: "/tmp/demo", targetPath: "/tmp/demo/../../escape.txt", expected: false },
    { rootDir: "/tmp/demo", targetPath: "sub/file.txt", expected: false },
  ])("checks containment for %j", ({ rootDir, targetPath, expected }) => {
    expect(isWithinDir(rootDir, targetPath)).toBe(expected);
  });
});

describe("realpath cache", () => {
  function linkDirectory(target: string, linkPath: string): void {
    fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
  }

  function removeDirectoryLink(linkPath: string): void {
    fs.rmSync(linkPath, { recursive: true, force: true });
  }

  it("safeRealpathSync can reuse a caller-scoped cache", async () => {
    await withTempDir({ prefix: "openclaw-cache-" }, async (base) => {
      const filePath = path.join(base, "test.txt");
      fs.writeFileSync(filePath, "hello");

      const realpathCache = new Map<string, string>();
      const first = safeRealpathSync(filePath, realpathCache);
      const second = safeRealpathSync(filePath, realpathCache);
      expect(first).not.toBeNull();
      expect(first).toBe(second);
    });
  });

  it("does not keep process-wide stale realpaths after symlink target changes", async () => {
    await withTempDir({ prefix: "openclaw-cache-" }, async (base) => {
      const targetA = path.join(base, "target-a");
      const targetB = path.join(base, "target-b");
      const linkPath = path.join(base, "link");

      fs.mkdirSync(targetA);
      fs.mkdirSync(targetB);
      linkDirectory(targetA, linkPath);

      const resultA = safeRealpathSync(linkPath);
      expect(resultA).toBe(fs.realpathSync(targetA));

      removeDirectoryLink(linkPath);
      linkDirectory(targetB, linkPath);

      const resultB = safeRealpathSync(linkPath);
      expect(resultB).toBe(fs.realpathSync(targetB));
    });
  });

  it("detects escapes after symlink changes without global invalidation", async () => {
    await withTempDir({ prefix: "openclaw-cache-" }, async (base) => {
      const root = path.join(base, "workspace");
      const safeTarget = path.join(root, "safe");
      const unsafeTarget = path.join(base, "outside");
      const linkPath = path.join(root, "link");

      fs.mkdirSync(safeTarget, { recursive: true });
      fs.mkdirSync(unsafeTarget, { recursive: true });
      linkDirectory(safeTarget, linkPath);

      expect(isPathInsideWithRealpath(root, linkPath)).toBe(true);

      removeDirectoryLink(linkPath);
      linkDirectory(unsafeTarget, linkPath);

      expect(isPathInsideWithRealpath(root, linkPath)).toBe(false);
    });
  });
});
