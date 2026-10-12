import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { pathMayExistSync } from "./path-existence.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("distinguishes definite absence from paths that may still exist", () => {
  const root = tempDirs.make("openclaw-path-existence-");
  const present = path.join(root, "present");
  fs.writeFileSync(present, "");
  expect(pathMayExistSync(present)).toBe(true);
  expect(pathMayExistSync(path.join(root, "missing"))).toBe(false);

  const dangling = path.join(root, "dangling");
  fs.symlinkSync("missing-target", dangling);
  expect(pathMayExistSync(dangling)).toBe(true);
  const blockedByFile = path.join(present, "child");
  expect(() => fs.lstatSync(blockedByFile)).toThrow(expect.objectContaining({ code: "ENOTDIR" }));
  expect(pathMayExistSync(blockedByFile)).toBe(false);
});

it.each(["EACCES", "EPERM", "ELOOP", "EIO"])("preserves uncertainty for %s", (code) => {
  const probe = vi.spyOn(fs, "lstatSync").mockImplementation(() => {
    throw Object.assign(new Error("filesystem probe failed"), { code });
  });
  try {
    expect(pathMayExistSync("unreadable-path")).toBe(true);
  } finally {
    probe.mockRestore();
  }
});
