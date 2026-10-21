import { unlinkSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { root as fsSafeRoot, type Root } from "@openclaw/fs-safe/root";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { PackageUpdateTransaction } from "./package-update-swap-contract.js";
import { swapStagedPackageInstall } from "./package-update-swap.js";
import {
  createPackageSwapFixture,
  createRetainedPackageSwap,
} from "./package-update-swap.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
let base: string;
beforeEach(() => {
  base = dirs.make("package-swap-");
});
afterEach(() => vi.restoreAllMocks());

const readText = (...parts: string[]) => fs.readFile(path.join(...parts), "utf8");

async function expectVersion(root: string, version: string) {
  expect(await readText(root, "package.json")).toContain(`"version":"${version}"`);
}

async function captureSwap(params: Parameters<typeof swapStagedPackageInstall>[0]) {
  let transaction: PackageUpdateTransaction | undefined;
  const result = await swapStagedPackageInstall({
    ...params,
    onTransaction: async (value) => {
      transaction = value;
      await params.onTransaction?.(value);
    },
  });
  if (!transaction) {
    throw new Error("Missing retained transaction");
  }
  return { result, transaction };
}

function expectNoCalls(...mocks: unknown[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

const inode = async (entry: string) => (await fs.lstat(entry)).ino;
const inodes = (entries: string[]) => Promise.all(entries.map(inode));

describe("retained package backup retirement", () => {
  it("keeps launcher evidence with a published transaction when mutation admission throws", async () => {
    const { params, packageRoot, globalRoot, launcher } = await createPackageSwapFixture(base);
    const { result, transaction } = await captureSwap({
      ...params,
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
    await expect(readText(globalRoot, backup!, "openclaw")).resolves.toBe("old launcher\n");
    await expect(readText(launcher)).resolves.toBe("old launcher\n");
    expect(await transaction.rollback(() => {})).toMatchObject({ exitCode: 0 });
    expect(await transaction.complete({ activationVerified: false }, () => {})).toBeUndefined();
    expect(await fs.readdir(globalRoot)).toEqual(["openclaw"]);
  });

  it("does not copy or remove the old package after a denied backup rename", async () => {
    const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
    const rename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (String(args[0]) === packageRoot) {
        throw Object.assign(new Error("cross-device move"), { code: "EXDEV" });
      }
      return rename(...args);
    });
    const { result, transaction } = await captureSwap(params).finally(() =>
      renameSpy.mockRestore(),
    );
    expect(result).toMatchObject({ status: "failed", activePackageRoot: packageRoot });
    const snapshots = `${transaction.backupRoot}.databases`;
    await fs.mkdir(snapshots);
    const completion = await transaction.complete({ activationVerified: true }, () => {});
    await expect(fs.stat(snapshots)).resolves.toBeDefined();
    await expect(readText(packageRoot, "dist", "index.js")).resolves.toBe("export {};\n");
    await expect(fs.stat(transaction.backupRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readText(launcher)).resolves.toBe("old launcher\n");
    expect(completion).toMatchObject({
      exitCode: 1,
      stderrTail: expect.stringContaining("Installation recovery is unverified"),
    });
  });

  it("preserves replacement, later-created, and unrelated recovery artifacts after activation", async () => {
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
      expect(await readText(directory, "sentinel")).toBe("successor bytes");
    }
    for (const name of [
      ".openclaw.package-backup-1-100.candidate",
      ".openclaw.package-backup-manual",
    ]) {
      expect(await readText(globalRoot, name, "sentinel")).toBe("recovery bytes");
    }
    expect(await transaction.complete({ activationVerified: true }, () => {})).toBe(completion);
  });

  it("finishes activation with a warning when historical backup inspection fails", async () => {
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
    expect(await readText(retained, "snapshot.sqlite")).toBe("pre-migration bytes");
    expect(await transaction.complete({ activationVerified: true }, () => {})).toBe(completion);
  });
});

describe("launcher backup capture", () => {
  it("preserves the installation after launcher backup and cleanup fail", async () => {
    const { params, packageRoot, globalRoot, launcher } = await createPackageSwapFixture(base);
    const secondLauncher = `${launcher}.cmd`;
    await fs.writeFile(secondLauncher, "old command launcher\n");
    await fs.writeFile(
      path.join(params.stage.layout.binDir, "openclaw.cmd"),
      "candidate command launcher\n",
    );
    const originals = await inodes([packageRoot, launcher, secondLauncher]);
    const prototype = Object.getPrototypeOf(await fsSafeRoot(base)) as Root;
    // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted Root receiver to preserve its path and mutation authority.
    const copyIn = prototype.copyIn;
    // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted Root receiver to preserve its path and mutation authority.
    const removeEntry = prototype.remove;
    const rename = fs.rename.bind(fs);
    const refusals = { copy: 0, cleanup: 0, retirement: 0 };
    vi.spyOn(prototype, "remove").mockImplementation(async function (
      this: Root,
      relativePath,
      options,
    ) {
      const target = path.resolve(this.rootReal, relativePath);
      // Let each copy finish cleaning its private staging directory first.
      if (
        path.basename(target) === path.basename(launcher) &&
        path.basename(path.dirname(target)).startsWith(".openclaw.shim-backup-")
      ) {
        refusals.cleanup += 1;
        throw Object.assign(new Error("backup cleanup denied"), { code: "EACCES" });
      }
      return removeEntry.call(this, relativePath, options);
    });
    vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (path.basename(String(args[0])).startsWith(".openclaw.shim-backup-")) {
        refusals.retirement += 1;
        throw Object.assign(new Error("backup retirement denied"), { code: "EACCES" });
      }
      return rename(...args);
    });
    let firstBackup: string | undefined;
    vi.spyOn(prototype, "copyIn").mockImplementation(async function (
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
        firstBackup = await readText(globalRoot, backupDir, "openclaw");
        refusals.copy += 1;
        throw new Error("second launcher backup refused");
      }
      await copyIn.call(this, destination, source, options);
    });
    const beforeActivate = vi.fn();
    const onLiveMutation = vi.fn();
    const onTransaction = vi.fn();
    const result = await swapStagedPackageInstall({
      ...params,
      beforeActivate,
      onLiveMutation,
      onTransaction,
    });
    expect(firstBackup).toBe("old launcher\n");
    expect(refusals).toEqual({ copy: 1, cleanup: 1, retirement: 1 });
    expect(result).toMatchObject({
      status: "failed",
      activePackageRoot: packageRoot,
      packageRollbackVerified: false,
      step: {
        exitCode: 1,
        stderrTail: expect.stringContaining("second launcher backup refused"),
      },
    });
    expectNoCalls(beforeActivate, onLiveMutation, onTransaction);
    expect(result.step.stderrTail).not.toContain("Installation recovery is unverified");
    expect(await inodes([packageRoot, launcher, secondLauncher])).toEqual(originals);
    await expectVersion(packageRoot, "1.0.0");
    await expect(readText(launcher)).resolves.toBe("old launcher\n");
    await expect(readText(secondLauncher)).resolves.toBe("old command launcher\n");
    const remaining = await fs.readdir(globalRoot);
    expect(remaining).toHaveLength(2);
    expect(remaining).toContain("openclaw");
    const backup = remaining.find((entry) => entry.startsWith(".openclaw.shim-backup-"));
    expect(backup).toBeDefined();
    await expect(readText(globalRoot, backup!, "openclaw")).resolves.toBe("old launcher\n");
    expect(result.step.stderrTail).toContain("preserved shim backup");
  });
});

describe("launcher observations", () => {
  it.runIf(process.platform !== "win32").each([false, true])(
    "handles a relinked launcher during verification (foreign=%s)",
    async (foreign) => {
      const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
      const target = "../lib/node_modules/openclaw/openclaw.mjs";
      const replacement = foreign ? "../lib/node_modules/foreign/cli.mjs" : target;
      await fs.writeFile(path.join(packageRoot, "openclaw.mjs"), "old launcher\n");
      await fs.unlink(launcher);
      await fs.symlink(target, launcher);
      let injected = false;
      const readlink = fs.readlink.bind(fs);
      vi.spyOn(fs, "readlink").mockImplementation(async (...args) => {
        const value = await readlink(...args);
        if (String(args[0]) === launcher && !injected) {
          injected = true;
          await fs.rename(launcher, `${launcher}.original`);
          await fs.symlink(replacement, launcher);
        }
        return value;
      });
      const onLiveMutation = vi.fn();
      const result = await swapStagedPackageInstall({ ...params, onLiveMutation });
      expect(injected).toBe(true);
      if (foreign) {
        expect(result.status).toBe("failed");
        expect(result.step.stderrTail).toContain(target);
        expect(result.step.stderrTail).toContain(replacement);
        expect(onLiveMutation).not.toHaveBeenCalled();
        expect(await fs.readlink(launcher)).toBe(replacement);
        await expectVersion(packageRoot, "1.0.0");
      } else {
        expect(result.status, result.step.stderrTail ?? "").toBe("committed");
        expect(await readText(launcher)).toBe("candidate launcher\n");
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "verifies launcher backup bytes despite rewritten metadata and restores them",
    async () => {
      const { params, launcher } = await createPackageSwapFixture(base);
      const rename = fs.rename.bind(fs);
      let injected = false;
      vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
        await rename(...args);
        if (String(args[1]).includes(".openclaw.shim-backup-") && !injected) {
          injected = true;
          await fs.chmod(args[1], 0o751);
        }
      });
      const result = await swapStagedPackageInstall({
        ...params,
        postVerifyStep: async () => ({
          name: "verification",
          command: "verify",
          cwd: params.stage.prefix,
          durationMs: 0,
          exitCode: 1,
        }),
      });
      expect(injected).toBe(true);
      expect(result).toMatchObject({ status: "failed", packageRollbackVerified: true });
      expect(await readText(launcher)).toBe("old launcher\n");
    },
  );
});

describe("retained package transaction authority", () => {
  afterEach(() => __setFsSafeTestHooksForTest(undefined));
  it("stops a partial npm activation before launcher compensation after executor loss", async () => {
    const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
    const { result, transaction } = await captureSwap({
      ...params,
      onTransaction: () => {
        unlinkSync(path.join(params.stage.layout.binDir, "openclaw"));
      },
    });
    expect(result.status).toBe("failed");
    const launcherIdentity = (await fs.lstat(launcher)).ino;
    const candidate = `${transaction.backupRoot}.candidate`;
    let current = true;
    const assertCurrent = () => {
      if (!current) {
        throw new Error("partial activation executor lost");
      }
    };
    const rename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      await rename(...args);
      current = false;
    });
    const prototype = Object.getPrototypeOf(await fsSafeRoot(base)) as Root;
    const copy = vi.spyOn(prototype, "copyIn");
    await expect(transaction.rollback(assertCurrent)).rejects.toThrow(
      "partial activation executor lost",
    );
    await expect(transaction.complete({ activationVerified: true }, () => {})).rejects.toThrow(
      "partial activation executor lost",
    );
    expect(renameSpy).toHaveBeenCalledExactlyOnceWith(packageRoot, candidate);
    expect(copy).not.toHaveBeenCalled();
    expect((await fs.lstat(launcher)).ino).toBe(launcherIdentity);
    await expect(fs.lstat(packageRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expectVersion(candidate, "2.0.0");
    await expectVersion(transaction.backupRoot, "1.0.0");
  });

  it.each(["integrity", "displacement", "compensation", "launcher", "retirement"] as const)(
    "stops rollback and preserves recovery material after ownership loss during %s",
    async (boundary) => {
      const { transaction, packageRoot, launcher, globalRoot } =
        await createRetainedPackageSwap(base);
      const candidate = `${transaction.backupRoot}.candidate`;
      const shimBackup = (await fs.readdir(globalRoot)).find((entry) =>
        entry.startsWith(".openclaw.shim-backup-"),
      )!;
      const shimBackupPath = await fs.realpath(path.join(globalRoot, shimBackup));
      const launcherParent = await fs.realpath(path.dirname(launcher));
      let current = true;
      let injections = 0;
      const revoke = () => {
        if (current) {
          injections += 1;
          current = false;
        }
      };
      const lost = new Error("original executor lost");
      const assertCurrent = () => {
        if (!current) {
          throw lost;
        }
      };
      const staleEffects: string[] = [];
      const privateStages = new Set<string>();
      const record = (operation: string, destination: string) => {
        // Unpublished, operation-owned launcher scratch is disposable even
        // after revocation; live paths and retained evidence are not.
        const privateTarget = [...privateStages].some(
          (stage) => destination === stage || destination.startsWith(`${stage}${path.sep}`),
        );
        if (!current && !privateTarget) {
          staleEffects.push(`${operation}: ${destination}`);
        }
      };
      const lstat = fs.lstat.bind(fs);
      vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        const result = await lstat(...args);
        if (boundary === "integrity" && String(args[0]) === transaction.backupRoot) {
          revoke();
        }
        return result;
      });
      const rename = fs.rename.bind(fs);
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
        record("rename", String(args[1]));
        if (boundary === "compensation" && String(args[0]) === transaction.backupRoot) {
          revoke();
          throw Object.assign(new Error("restore denied"), { code: "EACCES" });
        }
        await rename(...args);
        if (boundary === "displacement" && String(args[0]) === packageRoot) {
          revoke();
        }
      });
      const prototype = Object.getPrototypeOf(await fsSafeRoot(base)) as Root;
      // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted Root receiver to preserve its path and mutation authority.
      const copy = prototype.copyIn;
      vi.spyOn(prototype, "copyIn").mockImplementation(async function (
        this: Root,
        target,
        source,
        options,
      ) {
        expect(path.dirname(this.rootReal)).toBe(launcherParent);
        expect(path.basename(this.rootReal)).toMatch(/^\.openclaw-shim-stage-/);
        privateStages.add(this.rootReal);
        record("copy", path.join(this.rootReal, target));
        await copy.call(this, target, source, options);
        if (boundary === "launcher") {
          revoke();
        }
      });
      const chmod = fs.chmod.bind(fs);
      vi.spyOn(fs, "chmod").mockImplementation(async (...args) => {
        record("chmod", String(args[0]));
        return chmod(...args);
      });
      const unlink = fs.unlink.bind(fs);
      vi.spyOn(fs, "unlink").mockImplementation(async (...args) => {
        record("unlink", String(args[0]));
        await unlink(...args);
      });
      const rmdir = fs.rmdir.bind(fs);
      vi.spyOn(fs, "rmdir").mockImplementation(async (...args) => {
        record("rmdir", String(args[0]));
        await rmdir(...args);
      });
      __setFsSafeTestHooksForTest({
        beforeRootFallbackMutation(operation, target) {
          if (
            boundary === "retirement" &&
            operation === "remove" &&
            (target === shimBackupPath || target.startsWith(`${shimBackupPath}${path.sep}`))
          ) {
            revoke();
          }
        },
      });
      await expect(transaction.rollback(assertCurrent)).rejects.toBe(lost);
      expect(() => transaction.rollback(() => {})).toThrow(lost);
      await expect(transaction.complete({ activationVerified: true }, () => {})).rejects.toBe(lost);
      expect({ current, injections, staleEffects }).toEqual({
        current: false,
        injections: 1,
        staleEffects: [],
      });
      expect(await fs.readdir(path.dirname(launcher))).toEqual(["openclaw"]);
      await expect(fs.stat(path.join(globalRoot, shimBackup))).resolves.toBeDefined();
      if (boundary === "integrity") {
        await expectVersion(packageRoot, "2.0.0");
        expect(renameSpy).not.toHaveBeenCalled();
      } else {
        await expectVersion(candidate, "2.0.0");
      }
      if (boundary === "displacement" || boundary === "compensation") {
        await expect(fs.lstat(packageRoot)).rejects.toMatchObject({ code: "ENOENT" });
      }
      const previous =
        boundary === "launcher" || boundary === "retirement" ? packageRoot : transaction.backupRoot;
      await expectVersion(previous, "1.0.0");
      await expect(readText(launcher)).resolves.toBe(
        boundary === "retirement" ? "old launcher\n" : "candidate launcher\n",
      );
    },
  );

  it("keeps the original completion authority through a failed backup removal", async () => {
    const { transaction, packageRoot } = await createRetainedPackageSwap(base);
    let current = true;
    const refusal = new Error("retirement executor lost");
    const assertCurrent = () => {
      if (!current) {
        throw refusal;
      }
    };
    const backupRoot = await fs.realpath(transaction.backupRoot);
    let injections = 0;
    __setFsSafeTestHooksForTest({
      beforeRootFallbackMutation(operation, target) {
        if (
          operation === "remove" &&
          (target === backupRoot || target.startsWith(`${backupRoot}${path.sep}`))
        ) {
          injections += 1;
          current = false;
        }
      },
    });
    const unlink = vi.spyOn(fs, "unlink");
    const rmdir = vi.spyOn(fs, "rmdir");
    const rename = vi.spyOn(fs, "rename");
    await expect(transaction.complete({ activationVerified: true }, assertCurrent)).rejects.toBe(
      refusal,
    );
    await expect(transaction.complete({ activationVerified: true }, () => {})).rejects.toBe(
      refusal,
    );
    expectNoCalls(rename, unlink, rmdir);
    expect(injections).toBe(1);
    await expectVersion(transaction.backupRoot, "1.0.0");
    await expectVersion(packageRoot, "2.0.0");
  });
});
