import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { swapStagedPackageInstall } from "./package-update-swap.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";

afterEach(() => vi.restoreAllMocks());

it("refuses a borrowed dependency before activation without inventing a failed restoration", async () => {
  await withTestDir({ prefix: "openclaw-hoisted-baseline-refusal-" }, async (base) => {
    const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
    const borrowed = path.join(path.dirname(packageRoot), "borrowed");
    const slot = path.join(packageRoot, "node_modules", "borrowed");
    await fs.mkdir(borrowed);
    await fs.writeFile(path.join(borrowed, "index.js"), "export const owner = 'sibling';\n");
    await fs.mkdir(path.dirname(slot));
    await fs.symlink(
      process.platform === "win32" ? borrowed : path.relative(path.dirname(slot), borrowed),
      slot,
      process.platform === "win32" ? "junction" : "dir",
    );
    const rootBefore = await fs.lstat(packageRoot, { bigint: true });
    const launcherBefore = await fs.readFile(launcher, "utf8");
    const borrowedBefore = await fs.lstat(borrowed, { bigint: true });
    const linkBefore = await fs.readlink(slot);
    const rename = vi.spyOn(fs, "rename");
    const beforeActivate = vi.fn();
    const onLiveMutation = vi.fn();
    const onTransaction = vi.fn();

    const result = await swapStagedPackageInstall({
      ...params,
      beforeActivate,
      onLiveMutation,
      onTransaction,
    });

    expect(result).toMatchObject({
      status: "failed",
      activePackageRoot: packageRoot,
      packageRollbackVerified: false,
      step: { exitCode: 1 },
    });
    expect(result.step.stderrTail).toContain("symlink leaves the retained tree");
    expect(result.step.stderrTail).not.toContain("Package rollback verification failed");
    expect(result.step.stderrTail).not.toMatch(/(?:retained|restored) package .*changed/u);
    expect(beforeActivate).not.toHaveBeenCalled();
    expect(onLiveMutation).not.toHaveBeenCalled();
    expect(onTransaction).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(await fs.lstat(packageRoot, { bigint: true })).toMatchObject({
      ino: rootBefore.ino,
      dev: rootBefore.dev,
      mtimeNs: rootBefore.mtimeNs,
      ctimeNs: rootBefore.ctimeNs,
    });
    expect(await fs.lstat(borrowed, { bigint: true })).toMatchObject({
      ino: borrowedBefore.ino,
      dev: borrowedBefore.dev,
      mtimeNs: borrowedBefore.mtimeNs,
      ctimeNs: borrowedBefore.ctimeNs,
    });
    expect(await fs.readlink(slot)).toBe(linkBefore);
    expect(await fs.readFile(launcher, "utf8")).toBe(launcherBefore);
    expect(await fs.readFile(path.join(borrowed, "index.js"), "utf8")).toBe(
      "export const owner = 'sibling';\n",
    );
    expect(
      await fs.readFile(path.join(params.stage.packageRoot, "package.json"), "utf8"),
    ).toContain('"version":"2.0.0"');
  });
});
