import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";

const pathExistsMock = vi.hoisted(() => vi.fn());
const resolveSafeInstallDirMock = vi.hoisted(() => vi.fn());
const assertCanonicalPathWithinBaseMock = vi.hoisted(() => vi.fn());

vi.mock("./fs-safe.js", () => ({
  pathExists: (...args: unknown[]) => pathExistsMock(...args),
}));

vi.mock("./install-safe-path.js", () => ({
  resolveSafeInstallDir: (...args: unknown[]) => resolveSafeInstallDirMock(...args),
  assertCanonicalPathWithinBase: (...args: unknown[]) => assertCanonicalPathWithinBaseMock(...args),
}));

import { ensureInstallTargetAvailable, resolveCanonicalInstallTarget } from "./install-target.js";

beforeEach(() => {
  pathExistsMock.mockReset();
  resolveSafeInstallDirMock.mockReset();
  assertCanonicalPathWithinBaseMock.mockReset();
});

const withInstallDir = (run: (baseDir: string) => Promise<void>) =>
  withTestDir({ prefix: "openclaw-install-target-" }, run);
const resolveTarget = (baseDir: string, id = "demo") =>
  resolveCanonicalInstallTarget({
    baseDir,
    id,
    invalidNameMessage: "bad id",
    boundaryLabel: "plugin dir",
  });
const available = (mode: "install" | "update") =>
  ensureInstallTargetAvailable({
    mode,
    targetDir: "/tmp/demo",
    alreadyExistsError: "already there",
  });

describe("resolveCanonicalInstallTarget", () => {
  it("creates the base dir and returns early for invalid install ids", async () => {
    await withInstallDir(async (root) => {
      const baseDir = path.join(root, "plugins");
      resolveSafeInstallDirMock.mockReturnValueOnce({ ok: false, error: "bad id" });

      await expect(resolveTarget(baseDir, "../oops")).resolves.toEqual({
        ok: false,
        error: "bad id",
      });

      const baseDirStat = await fs.stat(baseDir);
      expect(baseDirStat.isDirectory()).toBe(true);
      expect(assertCanonicalPathWithinBaseMock).not.toHaveBeenCalled();
    });
  });

  it("returns canonical boundary errors for Error and non-Error throws", async () => {
    await withInstallDir(async (baseDir) => {
      const targetDir = path.join(baseDir, "demo");
      resolveSafeInstallDirMock.mockReturnValue({ ok: true, path: targetDir });
      assertCanonicalPathWithinBaseMock.mockRejectedValueOnce(new Error("escaped"));
      assertCanonicalPathWithinBaseMock.mockRejectedValueOnce("boom");

      await expect(resolveTarget(baseDir)).resolves.toEqual({ ok: false, error: "escaped" });
      await expect(resolveTarget(baseDir)).resolves.toEqual({ ok: false, error: "boom" });
    });
  });

  it("returns the resolved target path on success", async () => {
    await withInstallDir(async (baseDir) => {
      const targetDir = path.join(baseDir, "demo");
      resolveSafeInstallDirMock.mockReturnValueOnce({ ok: true, path: targetDir });

      await expect(resolveTarget(baseDir)).resolves.toEqual({ ok: true, targetDir });
    });
  });
});

describe("ensureInstallTargetAvailable", () => {
  it("blocks only install mode when the target already exists", async () => {
    pathExistsMock.mockResolvedValueOnce(true);
    pathExistsMock.mockResolvedValueOnce(false);

    await expect(available("install")).resolves.toEqual({ ok: false, error: "already there" });
    await expect(available("update")).resolves.toEqual({ ok: true });
    await expect(available("install")).resolves.toEqual({ ok: true });
  });
});
