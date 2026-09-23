import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { swapStagedPackageInstall, type PackageUpdateTransaction } from "./package-update-swap.js";
import {
  createPackageSwapFixture,
  createRetainedPackageSwap,
} from "./package-update-swap.test-support.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

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
      expect(result.step.failureFacts).toMatchObject([
        { check: "package-swap", code: "Error", message: "mutation admission refused" },
      ]);
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
  it.runIf(process.platform !== "win32").each(["symlink", "file"] as const)(
    "backs up a mode-0700 %s launcher and restores it through rollback",
    async (kind) => {
      const base = dirs.make("openclaw-launcher-backup-mode-");
      const { params, launcher } = await createPackageSwapFixture(base);
      const target = "../lib/node_modules/openclaw/package.json";
      if (kind === "file") {
        await fs.chmod(launcher, 0o700);
      } else {
        await fs.unlink(launcher);
        await fs.symlink(target, launcher);
        if (process.platform === "darwin") {
          await fs.lchmod(launcher, 0o700);
        } else {
          // Linux fixes symlink modes at 0777; expose the macOS source mode to the reader.
          const lstat = fs.lstat.bind(fs);
          vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
            const stat = await lstat(...args);
            if (String(args[0]) === launcher && stat.isSymbolicLink()) {
              stat.mode = typeof stat.mode === "bigint" ? 0o120700n : 0o120700;
            }
            return stat;
          });
        }
      }
      const rename = fs.rename.bind(fs);
      vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
        await rename(...args);
        if (
          kind === "symlink" &&
          process.platform === "darwin" &&
          path.basename(path.dirname(String(args[1]))).startsWith(".openclaw.shim-backup-")
        ) {
          await fs.lchmod(args[1], 0o755);
        }
      });
      let transaction: PackageUpdateTransaction | undefined;
      const result = await swapStagedPackageInstall({
        ...params,
        onTransaction: (value) => {
          transaction = value;
        },
      });
      expect(result.status, result.step.stderrTail ?? "").toBe("committed");
      expect(await fs.readFile(launcher, "utf8")).toBe("candidate launcher\n");
      expect(await transaction!.rollback(() => {})).toMatchObject({ exitCode: 0 });
      if (kind === "symlink") {
        expect(await fs.readlink(launcher)).toBe(target);
      } else {
        expect(await fs.readFile(launcher, "utf8")).toBe("old launcher\n");
        expect((await fs.stat(launcher)).mode & 0o777).toBe(0o700);
      }
      expect(await transaction!.complete({ activationVerified: false }, () => {})).toBeUndefined();
    },
  );

  it.runIf(process.platform !== "win32").each(["target", "type", "mode", "contents"] as const)(
    "names a changed backup %s and retains the failed copy before activation",
    async (field) => {
      const base = dirs.make("openclaw-launcher-backup-changed-");
      const { params, launcher, packageRoot } = await createPackageSwapFixture(base);
      if (field === "target" || field === "type") {
        await fs.unlink(launcher);
        await fs.symlink("../lib/node_modules/openclaw/package.json", launcher);
      } else {
        await fs.chmod(launcher, 0o755);
      }
      const original = await fs.lstat(launcher);
      const rename = fs.rename.bind(fs);
      let backup = "";
      vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
        await rename(...args);
        if (!path.basename(path.dirname(String(args[1]))).startsWith(".openclaw.shim-backup-")) {
          return;
        }
        backup = String(args[1]);
        if (field === "target" || field === "type") {
          await fs.unlink(backup);
          if (field === "target") {
            await fs.symlink("different-target", backup);
          } else {
            await fs.writeFile(backup, "different type");
          }
        } else if (field === "mode") {
          await fs.chmod(backup, 0o700);
        } else {
          await fs.writeFile(backup, "different contents");
        }
      });
      const beforeActivate = vi.fn();
      const result = await swapStagedPackageInstall({ ...params, beforeActivate });
      expect(result.status).toBe("failed");
      expect(result.step.stderrTail).toContain(`differing fields: ${field}`);
      expect(result.step.stderrTail).toContain(`failed copy retained at ${backup}`);
      expect(updateRunStepsFromResultStep(result.step)[0]?.detail).toBe(
        "Exit code: 1; Package rollback launcher backup changed: [redacted-path]",
      );
      expect(beforeActivate).not.toHaveBeenCalled();
      expect((await fs.lstat(launcher)).ino).toBe(original.ino);
      expect(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")).toContain(
        '"version":"1.0.0"',
      );
      expect(await fs.lstat(backup)).toBeDefined();
      if (field === "target") {
        expect(await fs.readlink(backup)).toBe("different-target");
      }
    },
  );

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
