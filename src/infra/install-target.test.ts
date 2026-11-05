import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";

const pathExistsMock = vi.hoisted(() => vi.fn());
const resolveSafeInstallDirMock = vi.hoisted(() => vi.fn());
const assertCanonicalPathWithinBaseMock = vi.hoisted(() => vi.fn());

// mock-isolation: target admission tests control path existence without accessing installed plugins.
vi.mock("./fs-safe.js", () => ({ pathExists: pathExistsMock }));

// mock-isolation: exercise admission sequencing independently of the path-security implementation.
vi.mock("./install-safe-path.js", () => ({
  resolveSafeInstallDir: resolveSafeInstallDirMock,
  assertCanonicalPathWithinBase: assertCanonicalPathWithinBaseMock,
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

it("creates the base dir and returns early for invalid install ids", async () => {
  await withInstallDir(async (root) => {
    const baseDir = path.join(root, "plugins");
    resolveSafeInstallDirMock.mockReturnValueOnce({ ok: false, error: "bad id" });

    await expect(resolveTarget(baseDir, "../oops")).resolves.toEqual({
      ok: false,
      error: "bad id",
    });

    expect((await fs.stat(baseDir)).isDirectory()).toBe(true);
    expect(assertCanonicalPathWithinBaseMock).not.toHaveBeenCalled();
  });
});

it.each([
  [new Error("escaped"), "escaped"],
  ["boom", "boom"],
  [undefined, undefined],
])("resolves a canonical target or reports the boundary error (%j)", async (error, message) => {
  await withInstallDir(async (baseDir) => {
    const targetDir = path.join(baseDir, "demo");
    resolveSafeInstallDirMock.mockReturnValueOnce({ ok: true, path: targetDir });
    if (error !== undefined) {
      assertCanonicalPathWithinBaseMock.mockRejectedValueOnce(error);
    }
    await expect(resolveTarget(baseDir)).resolves.toEqual(
      message === undefined ? { ok: true, targetDir } : { ok: false, error: message },
    );
  });
});
it("blocks only install mode when the target already exists", async () => {
  pathExistsMock.mockResolvedValueOnce(true);
  pathExistsMock.mockResolvedValueOnce(false);

  await expect(available("install")).resolves.toEqual({ ok: false, error: "already there" });
  await expect(available("update")).resolves.toEqual({ ok: true });
  await expect(available("install")).resolves.toEqual({ ok: true });
});
