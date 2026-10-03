import fs from "node:fs/promises";
import path from "node:path";
import { root as fsSafeRoot, type Root } from "@openclaw/fs-safe/root";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import type { PackageUpdateTransaction } from "./package-update-swap-contract.js";
import { swapStagedPackageInstall } from "./package-update-swap.js";
import {
  createPackageSwapFixture,
  createRetainedPackageSwap,
} from "./package-update-swap.test-support.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

describe("retained package backup retirement", () => {
  it.each(["missing", "verified", "advisory"] as const)(
    "preserves historical backups without an activation transaction (%s)",
    async (verification) => {
      const base = await fs.realpath(dirs.make("openclaw-direct-historical-backup-"));
      const { params, globalRoot, packageRoot } = await createPackageSwapFixture(base);
      const historical = path.join(globalRoot, ".openclaw.package-backup-1-100");
      await fs.mkdir(historical);
      await fs.writeFile(path.join(historical, "sentinel"), "historical package");
      const result = await swapStagedPackageInstall({
        ...params,
        postVerifyStep:
          verification === "missing"
            ? undefined
            : async (root) => ({
                name: "package-verify",
                command: "verify fixture",
                cwd: root,
                durationMs: 0,
                exitCode: verification === "verified" ? 0 : 1,
                advisory:
                  verification === "advisory"
                    ? { kind: "recoverable-maintenance", message: "verification incomplete" }
                    : undefined,
              }),
      });
      expect(result.status, result.step.stderrTail ?? "").toBe("committed");
      expect(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")).toContain(
        '"version":"2.0.0"',
      );
      expect(await fs.readFile(path.join(historical, "sentinel"), "utf8")).toBe(
        "historical package",
      );
    },
  );

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
        const snapshots = `${transaction!.backupRoot}.databases`;
        await fs.mkdir(snapshots);
        const completion = await transaction!.complete({ activationVerified }, () => {});
        await expect(fs.stat(snapshots)).resolves.toBeDefined();
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

  it.each([
    "unverified activation",
    "verified activation",
    "verified rollback",
    "refused rollback",
  ] as const)("retires backups only after a proven outcome: %s", async (outcome) => {
    await withTestDir({ prefix: "openclaw-retained-outcome-" }, async (base) => {
      const checkout = path.join(base, "earlier-checkout");
      await fs.mkdir(checkout);
      await fs.writeFile(path.join(checkout, "sentinel"), "operator checkout");
      const { result, transaction, packageRoot, globalRoot } = await createRetainedPackageSwap(
        base,
        async ({ globalRoot: fixtureGlobalRoot }) => {
          const directory = path.join(fixtureGlobalRoot, ".openclaw.package-backup-1-100");
          await fs.mkdir(directory);
          await fs.writeFile(path.join(directory, "sentinel"), "earlier package");
          for (const name of [".openclaw.package-backup-2-200", ".openclaw-package-backup-3-300"]) {
            await fs.symlink(
              checkout,
              path.join(fixtureGlobalRoot, name),
              process.platform === "win32" ? "junction" : "dir",
            );
          }
          const snapshots = `${directory}.databases`;
          await fs.mkdir(snapshots);
          await fs.writeFile(path.join(snapshots, "snapshot.sqlite"), "pre-migration bytes");
        },
      );
      const snapshots = `${transaction.backupRoot}.databases`;
      const olderSnapshots = path.join(globalRoot, ".openclaw.package-backup-1-100.databases");
      await fs.mkdir(snapshots);
      await fs.writeFile(path.join(snapshots, "snapshot.sqlite"), "pre-migration bytes");
      expect(result.status).toBe("committed");
      if (outcome === "refused rollback") {
        await fs.writeFile(path.join(transaction.backupRoot, "dist", "index.js"), "changed");
        expect(await transaction.rollback(() => {})).toMatchObject({ exitCode: 1 });
      }
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
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        `"version":"${outcome === "verified rollback" ? "1.0.0" : "2.0.0"}"`,
      );
      if (outcome === "unverified activation" || outcome === "refused rollback") {
        expect(completion).toMatchObject({ exitCode: 1 });
        await expect(fs.stat(transaction.backupRoot)).resolves.toBeDefined();
      } else {
        expect(completion).toBeUndefined();
        await expect(fs.stat(transaction.backupRoot)).rejects.toMatchObject({ code: "ENOENT" });
      }
      if (outcome === "verified activation") {
        await expect(fs.stat(snapshots)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expect(fs.readFile(path.join(snapshots, "snapshot.sqlite"), "utf8")).resolves.toBe(
          "pre-migration bytes",
        );
      }
      await expect(fs.readFile(path.join(olderSnapshots, "snapshot.sqlite"), "utf8")).resolves.toBe(
        "pre-migration bytes",
      );
      for (const name of [
        ".openclaw.package-backup-1-100",
        ".openclaw.package-backup-2-200",
        ".openclaw-package-backup-3-300",
      ]) {
        if (outcome === "verified activation") {
          await expect(fs.lstat(path.join(globalRoot, name))).rejects.toMatchObject({
            code: "ENOENT",
          });
        } else {
          await expect(fs.lstat(path.join(globalRoot, name))).resolves.toBeDefined();
        }
      }
      await expect(fs.readFile(path.join(checkout, "sentinel"), "utf8")).resolves.toBe(
        "operator checkout",
      );
    });
  });

  it("preserves replacement, later-created, and unrelated recovery artifacts after activation", async () => {
    const base = await fs.realpath(dirs.make("openclaw-historical-backup-replaced-"));
    const { transaction, globalRoot } = await createRetainedPackageSwap(
      base,
      async ({ globalRoot: fixtureGlobalRoot }) => {
        await fs.mkdir(path.join(fixtureGlobalRoot, ".openclaw.package-backup-1-100"));
        for (const name of [
          ".openclaw.package-backup-1-100.candidate",
          ".openclaw.package-backup-manual",
        ]) {
          await fs.mkdir(path.join(fixtureGlobalRoot, name));
          await fs.writeFile(path.join(fixtureGlobalRoot, name, "sentinel"), "recovery bytes");
        }
      },
    );
    const replaced = path.join(globalRoot, ".openclaw.package-backup-1-100");
    await fs.rename(replaced, path.join(base, "captured-backup"));
    const later = path.join(globalRoot, ".openclaw.package-backup-2-200");
    for (const directory of [replaced, later]) {
      await fs.mkdir(directory);
      await fs.writeFile(path.join(directory, "sentinel"), "successor bytes");
    }

    const completion = await transaction.complete({ activationVerified: true }, () => {});
    expect(completion).toMatchObject({
      advisory: { kind: "recoverable-maintenance", message: expect.stringContaining(replaced) },
    });
    for (const directory of [replaced, later]) {
      expect(await fs.readFile(path.join(directory, "sentinel"), "utf8")).toBe("successor bytes");
    }
    for (const name of [
      ".openclaw.package-backup-1-100.candidate",
      ".openclaw.package-backup-manual",
    ]) {
      expect(await fs.readFile(path.join(globalRoot, name, "sentinel"), "utf8")).toBe(
        "recovery bytes",
      );
    }
    expect(await transaction.complete({ activationVerified: true }, () => {})).toBe(completion);
  });

  it("finishes activation with a warning when historical backup inspection fails", async () => {
    const base = await fs.realpath(dirs.make("openclaw-historical-backup-inspection-"));
    const readdir = fs.readdir.bind(fs);
    const { transaction, globalRoot } = await createRetainedPackageSwap(
      base,
      async ({ globalRoot: fixtureGlobalRoot }) => {
        await fs.mkdir(path.join(fixtureGlobalRoot, ".openclaw.package-backup-1-100"));
        vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
          if (String(args[0]) === fixtureGlobalRoot) {
            throw Object.assign(new Error("backup inspection denied"), { code: "EACCES" });
          }
          return readdir(...args);
        });
      },
    );
    const completion = await transaction.complete({ activationVerified: true }, () => {});
    expect(completion).toMatchObject({
      advisory: {
        kind: "recoverable-maintenance",
        message: expect.stringContaining("backup inspection denied"),
      },
    });
    await expect(
      fs.lstat(path.join(globalRoot, ".openclaw.package-backup-1-100")),
    ).resolves.toBeDefined();
  });

  it("reports database cleanup failure as recoverable maintenance after verified activation", async () => {
    const base = await fs.realpath(dirs.make("openclaw-database-retirement-"));
    const { transaction } = await createRetainedPackageSwap(base);
    const snapshots = `${transaction.backupRoot}.databases`;
    await fs.mkdir(snapshots);
    await fs.writeFile(path.join(snapshots, "snapshot.sqlite"), "pre-migration bytes");
    const prototype = Object.getPrototypeOf(await fsSafeRoot(base)) as Root;
    // oxlint-disable-next-line typescript/unbound-method -- Preserve the intercepted Root receiver for unrelated cleanup.
    const removeEntry = prototype.remove;
    vi.spyOn(prototype, "remove").mockImplementation(async function (
      this: Root,
      relativePath,
      options,
    ) {
      const target = path.resolve(this.rootReal, relativePath);
      if (target === snapshots || target.startsWith(`${snapshots}${path.sep}`)) {
        throw Object.assign(new Error("snapshot cleanup denied"), { code: "EACCES" });
      }
      return removeEntry.call(this, relativePath, options);
    });
    const completion = await transaction.complete({ activationVerified: true }, () => {});
    const retained = snapshots.replace(".openclaw.package-backup-", ".openclaw-package-backup-");
    expect(completion).toMatchObject({
      exitCode: 1,
      advisory: { kind: "recoverable-maintenance", message: expect.stringContaining(retained) },
    });
    expect(await fs.readFile(path.join(retained, "snapshot.sqlite"), "utf8")).toBe(
      "pre-migration bytes",
    );
    expect(await transaction.complete({ activationVerified: true }, () => {})).toBe(completion);
  });
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
        const prototype = Object.getPrototypeOf(await fsSafeRoot(base)) as Root;
        // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted Root receiver to preserve its path and mutation authority.
        const copyIn = prototype.copyIn;
        // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted Root receiver to preserve its path and mutation authority.
        const removeEntry = prototype.remove;
        const rename = fs.rename.bind(fs);
        let copyRefusals = 0;
        let cleanupRefusals = 0;
        let retirementRefusals = 0;
        const remove = vi.spyOn(prototype, "remove").mockImplementation(async function (
          this: Root,
          relativePath,
          options,
        ) {
          const target = path.resolve(this.rootReal, relativePath);
          // Let each copy finish cleaning its private staging directory first.
          if (
            cleanupDenied &&
            path.basename(target) === path.basename(launcher) &&
            path.basename(path.dirname(target)).startsWith(".openclaw.shim-backup-")
          ) {
            cleanupRefusals += 1;
            throw Object.assign(new Error("backup cleanup denied"), { code: "EACCES" });
          }
          return removeEntry.call(this, relativePath, options);
        });
        const move = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
          if (
            cleanupDenied &&
            path.basename(String(args[0])).startsWith(".openclaw.shim-backup-")
          ) {
            retirementRefusals += 1;
            throw Object.assign(new Error("backup retirement denied"), { code: "EACCES" });
          }
          return rename(...args);
        });
        let firstBackup: string | undefined;
        const copy = vi.spyOn(prototype, "copyIn").mockImplementation(async function (
          this: Root,
          destination,
          source,
          options,
        ) {
          if (source === secondLauncher) {
            const backupDir = (await fs.readdir(globalRoot)).find((entry) =>
              entry.startsWith(".openclaw.shim-backup-"),
            );
            if (!backupDir) {
              throw new Error("missing partial launcher backup");
            }
            firstBackup = await fs.readFile(path.join(globalRoot, backupDir, "openclaw"), "utf8");
            copyRefusals += 1;
            throw new Error("second launcher backup refused");
          }
          await copyIn.call(this, destination, source, options);
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
        expect(copyRefusals).toBe(1);
        expect(cleanupRefusals).toBe(cleanupDenied ? 1 : 0);
        expect(retirementRefusals).toBe(cleanupDenied ? 1 : 0);
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
