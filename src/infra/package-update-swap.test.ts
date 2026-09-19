import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { swapStagedPackageInstall, type PackageUpdateTransaction } from "./package-update-swap.js";
import {
  createPackageSwapFixture,
  createRetainedPackageSwap,
} from "./package-update-swap.test-support.js";

describe("retained package backup retirement", () => {
  it("keeps launcher evidence with a published transaction when mutation admission throws", async () => {
    await withTestDir({ prefix: "openclaw-retained-admission-" }, async (base) => {
      const { params, packageRoot, globalRoot, launcher } = await createPackageSwapFixture(base);
      let transaction: PackageUpdateTransaction | undefined;
      const result = await swapStagedPackageInstall({
        ...params,
        onTransaction: (value) => {
          transaction = value;
        },
        onLiveMutation: () => {
          throw new Error("mutation admission refused");
        },
      });
      expect(result).toMatchObject({ status: "failed", activePackageRoot: packageRoot });
      expect(result.step.stderrTail).toBe("mutation admission refused");
      const backup = (await fs.readdir(globalRoot)).find((entry) =>
        entry.startsWith(".openclaw.shim-backup-"),
      );
      expect(backup).toBeDefined();
      await expect(fs.readFile(path.join(globalRoot, backup!, "openclaw"), "utf8")).resolves.toBe(
        "old launcher\n",
      );
      await expect(fs.readFile(launcher, "utf8")).resolves.toBe("old launcher\n");
      expect(await transaction!.rollback(() => {})).toMatchObject({ exitCode: 0 });
      expect(await transaction!.complete({ activationVerified: false }, () => {})).toBeUndefined();
      expect(await fs.readdir(globalRoot)).toEqual(["openclaw"]);
    });
  });

  it.each([false, true])(
    "does not copy or remove the old package after a denied backup rename (caller verified=%s)",
    async (activationVerified) => {
      await withTestDir({ prefix: "openclaw-retained-backup-" }, async (base) => {
        const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
        const rename = fs.rename.bind(fs);
        const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
          if (String(args[0]) === packageRoot) {
            throw Object.assign(new Error("cross-device move"), { code: "EXDEV" });
          }
          return rename(...args);
        });
        let transaction: PackageUpdateTransaction | undefined;
        let result;
        try {
          result = await swapStagedPackageInstall({
            ...params,
            onTransaction: (value) => {
              transaction = value;
            },
          });
        } finally {
          renameSpy.mockRestore();
        }
        expect(transaction).toBeDefined();
        expect(result).toMatchObject({ status: "failed", activePackageRoot: packageRoot });
        const completion = await transaction!.complete({ activationVerified }, () => {});
        await expect(fs.readFile(path.join(packageRoot, "dist", "index.js"), "utf8")).resolves.toBe(
          "export {};\n",
        );
        await expect(fs.stat(transaction!.backupRoot)).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(fs.readFile(launcher, "utf8")).resolves.toBe("old launcher\n");
        expect(completion).toMatchObject({
          exitCode: 1,
          stderrTail: expect.stringContaining("Installation recovery is unverified"),
        });
      });
    },
  );

  it.each(["unverified activation", "verified activation", "verified rollback"] as const)(
    "retires backups only after a proven outcome: %s",
    async (outcome) => {
      await withTestDir({ prefix: "openclaw-retained-outcome-" }, async (base) => {
        const { result, transaction, packageRoot } = await createRetainedPackageSwap(base);
        expect(result.status).toBe("committed");
        if (outcome === "verified rollback") {
          expect(await transaction.rollback(() => {})).toMatchObject({
            exitCode: 0,
            activePackageRoot: packageRoot,
          });
        }
        const completion = await transaction.complete(
          {
            activationVerified: outcome === "verified activation",
          },
          () => {},
        );
        await expect(
          fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        ).resolves.toContain(`"version":"${outcome === "verified rollback" ? "1.0.0" : "2.0.0"}"`);
        if (outcome === "unverified activation") {
          await expect(fs.stat(transaction.backupRoot)).resolves.toBeDefined();
        } else {
          expect(completion).toBeUndefined();
          await expect(fs.stat(transaction.backupRoot)).rejects.toMatchObject({ code: "ENOENT" });
        }
      });
    },
  );
});

describe("launcher backup capture", () => {
  it.each([false, true])(
    "preserves the installation after a launcher backup failure (cleanup denied=%s)",
    async (cleanupDenied) => {
      await withTestDir({ prefix: "openclaw-partial-launcher-backup-" }, async (base) => {
        const { params, packageRoot, globalRoot, launcher } = await createPackageSwapFixture(base);
        const secondLauncher = `${launcher}.cmd`;
        await fs.writeFile(secondLauncher, "old command launcher\n");
        await fs.writeFile(
          path.join(params.stage.layout.binDir, "openclaw.cmd"),
          "candidate command launcher\n",
        );
        const originals = await Promise.all(
          [packageRoot, launcher, secondLauncher].map(async (entry) => (await fs.lstat(entry)).ino),
        );
        const copyFile = fs.copyFile.bind(fs);
        const rm = fs.rm.bind(fs);
        const rename = fs.rename.bind(fs);
        const remove = vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
          if (
            cleanupDenied &&
            path.basename(String(args[0])).startsWith(".openclaw.shim-backup-")
          ) {
            throw Object.assign(new Error("backup cleanup denied"), { code: "EACCES" });
          }
          return rm(...args);
        });
        const move = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
          if (
            cleanupDenied &&
            path.basename(String(args[0])).startsWith(".openclaw.shim-backup-")
          ) {
            throw Object.assign(new Error("backup retirement denied"), { code: "EACCES" });
          }
          return rename(...args);
        });
        let firstBackup: string | undefined;
        const copy = vi.spyOn(fs, "copyFile").mockImplementation(async (...args) => {
          if (String(args[0]) === secondLauncher) {
            const backupDir = (await fs.readdir(globalRoot)).find((entry) =>
              entry.startsWith(".openclaw.shim-backup-"),
            );
            if (!backupDir) {
              throw new Error("missing partial launcher backup");
            }
            firstBackup = await fs.readFile(path.join(globalRoot, backupDir, "openclaw"), "utf8");
            throw new Error("second launcher backup refused");
          }
          return copyFile(...args);
        });
        const beforeActivate = vi.fn();
        const onLiveMutation = vi.fn();
        const onTransaction = vi.fn();
        let result;
        try {
          result = await swapStagedPackageInstall({
            ...params,
            beforeActivate,
            onLiveMutation,
            onTransaction,
          });
        } finally {
          copy.mockRestore();
          remove.mockRestore();
          move.mockRestore();
        }
        expect(firstBackup).toBe("old launcher\n");
        expect(result).toMatchObject({
          status: "failed",
          activePackageRoot: packageRoot,
          packageRollbackVerified: false,
          step: {
            exitCode: 1,
            stderrTail: expect.stringContaining("second launcher backup refused"),
          },
        });
        expect(beforeActivate).not.toHaveBeenCalled();
        expect(result.step.stderrTail).not.toContain("Installation recovery is unverified");
        expect(onLiveMutation).not.toHaveBeenCalled();
        expect(onTransaction).not.toHaveBeenCalled();
        expect(
          await Promise.all(
            [packageRoot, launcher, secondLauncher].map(
              async (entry) => (await fs.lstat(entry)).ino,
            ),
          ),
        ).toEqual(originals);
        await expect(
          fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        ).resolves.toContain('"version":"1.0.0"');
        await expect(fs.readFile(launcher, "utf8")).resolves.toBe("old launcher\n");
        await expect(fs.readFile(secondLauncher, "utf8")).resolves.toBe("old command launcher\n");
        const remaining = await fs.readdir(globalRoot);
        if (cleanupDenied) {
          expect(remaining).toHaveLength(2);
          expect(remaining).toContain("openclaw");
          const backup = remaining.find((entry) => entry.startsWith(".openclaw.shim-backup-"));
          expect(backup).toBeDefined();
          await expect(
            fs.readFile(path.join(globalRoot, backup!, "openclaw"), "utf8"),
          ).resolves.toBe("old launcher\n");
          expect(result.step.stderrTail).toContain("preserved shim backup");
        } else {
          expect(remaining).toEqual(["openclaw"]);
          expect(result.step.stderrTail).toBe("second launcher backup refused");
        }
      });
    },
  );
});
