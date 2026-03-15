import path from "node:path";
import { describe, expect, it } from "vitest";
import { isWithinDir, resolveSafeBaseDir } from "./path-safety.js";

// Use path.resolve so expected values are correct on both Unix and Windows.
const demo = path.resolve("/tmp/demo");
const tmp = path.resolve("/tmp");

describe("path-safety", () => {
  it.each([
    { rootDir: "/tmp/demo", expected: `${demo}${path.sep}` },
    { rootDir: `/tmp/demo${path.sep}`, expected: `${demo}${path.sep}` },
    { rootDir: "/tmp/demo/..", expected: `${tmp}${path.sep}` },
  ])("resolves safe base dir for %j", ({ rootDir, expected }) => {
    expect(resolveSafeBaseDir(rootDir)).toBe(expected);
  });

  it.each([
    { rootDir: "/tmp/demo", targetPath: path.resolve("/tmp/demo"), expected: true },
    { rootDir: "/tmp/demo", targetPath: path.resolve("/tmp/demo/sub/file.txt"), expected: true },
    {
      rootDir: "/tmp/demo",
      targetPath: path.resolve("/tmp/demo/./nested/../file.txt"),
      expected: true,
    },
    {
      rootDir: "/tmp/demo",
      targetPath: path.resolve("/tmp/demo-two/../demo/file.txt"),
      expected: true,
    },
    { rootDir: "/tmp/demo", targetPath: path.resolve("/tmp/demo/../escape.txt"), expected: false },
    {
      rootDir: "/tmp/demo",
      targetPath: path.resolve("/tmp/demo-sibling/file.txt"),
      expected: false,
    },
    {
      rootDir: "/tmp/demo",
      targetPath: path.resolve("/tmp/demo/../../escape.txt"),
      expected: false,
    },
    { rootDir: "/tmp/demo", targetPath: "sub/file.txt", expected: false },
  ])("checks containment for %j", ({ rootDir, targetPath, expected }) => {
    expect(isWithinDir(rootDir, targetPath)).toBe(expected);
  });
});
