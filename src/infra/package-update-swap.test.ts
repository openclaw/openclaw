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
  it("cleans partial backups without moving the installation when a later launcher copy fails", async () => {
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
      }
      expect(firstBackup).toBe("old launcher\n");
      expect(result).toMatchObject({
        status: "failed",
        activePackageRoot: packageRoot,
        packageRollbackVerified: true,
        step: {
          exitCode: 1,
          stderrTail: expect.stringContaining("second launcher backup refused"),
        },
      });
      expect(beforeActivate).not.toHaveBeenCalled();
      expect(onLiveMutation).not.toHaveBeenCalled();
      expect(onTransaction).not.toHaveBeenCalled();
      expect(
        await Promise.all(
          [packageRoot, launcher, secondLauncher].map(async (entry) => (await fs.lstat(entry)).ino),
        ),
      ).toEqual(originals);
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"version":"1.0.0"',
      );
      await expect(fs.readFile(launcher, "utf8")).resolves.toBe("old launcher\n");
      await expect(fs.readFile(secondLauncher, "utf8")).resolves.toBe("old command launcher\n");
      expect(await fs.readdir(globalRoot)).toEqual(["openclaw"]);
    });
  });
});
