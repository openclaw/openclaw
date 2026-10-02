import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { root as fsSafeRoot, type Root } from "@openclaw/fs-safe/root";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import {
  installPackageDir,
  requestDeferredPackageDirInstall,
  resolvePackageDirInstallTransaction,
} from "./install-package-dir.js";
import {
  createExistingInstallFixture,
  listMatchingDirs,
  normalizeComparablePath,
} from "./install-package-dir.test-support.js";

describe("installPackageDir rollback", () => {
  const fixtureRootTracker = createSuiteTempRootTracker({
    prefix: "openclaw-install-package-dir-rollback-",
  });

  afterEach(async () => {
    __setFsSafeTestHooksForTest(undefined);
    vi.restoreAllMocks();
    await fixtureRootTracker.cleanup();
  });

  async function createFixture(name: string) {
    await fixtureRootTracker.setup();
    const fixtureRoot = await fixtureRootTracker.make(name);
    return { fixtureRoot, ...(await createExistingInstallFixture(fixtureRoot)) };
  }

  function updateOptions(sourceDir: string, targetDir: string) {
    return {
      sourceDir,
      targetDir,
      mode: "update" as const,
      timeoutMs: 1_000,
      copyErrorPrefix: "failed to copy plugin",
      hasDeps: false,
      depsLogMessage: "",
    };
  }

  async function installRetainedUpdate(
    sourceDir: string,
    targetDir: string,
    options: Pick<Parameters<typeof installPackageDir>[0], "sourceHardlinks"> = {},
  ) {
    let backupDir = "";
    const result = await installPackageDir(
      requestDeferredPackageDirInstall({
        ...updateOptions(sourceDir, targetDir),
        ...options,
        afterBackup: async (directory: string) => {
          backupDir = directory;
          return { ok: true as const };
        },
      }),
    );
    expect(result.ok).toBe(true);
    const transaction = resolvePackageDirInstallTransaction(result);
    if (!transaction) {
      throw new Error("Expected a retained package transaction");
    }
    return { backupDir, transaction };
  }

  it("reports incomplete recovery when a deferred backup cannot be restored", async () => {
    const { sourceDir, targetDir } = await createFixture("deferred-restore-blocked");
    const result = await installPackageDir(
      requestDeferredPackageDirInstall({
        ...updateOptions(sourceDir, targetDir),
        afterBackup: async () => {
          await fs.mkdir(targetDir, { recursive: true });
          await fs.writeFile(path.join(targetDir, "successor.txt"), "successor");
          return { ok: false as const, error: "backup rejected" };
        },
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      recoveryIncomplete: true,
      error: expect.stringContaining("backup retained"),
    });
    await expect(fs.readFile(path.join(targetDir, "successor.txt"), "utf8")).resolves.toBe(
      "successor",
    );
  });

  it("preserves the Windows EPERM backup copy fallback", async () => {
    const { sourceDir, targetDir } = await createFixture("windows-backup-eperm");
    let denied = false;
    const denyInitialBackupRename = (from: fsSync.PathLike, to: fsSync.PathLike) => {
      if (
        !denied &&
        normalizeComparablePath(String(from)) === normalizeComparablePath(targetDir) &&
        path.basename(path.dirname(String(to))) === ".openclaw-install-backups"
      ) {
        denied = true;
        throw Object.assign(new Error("Windows sharing violation"), { code: "EPERM" });
      }
    };
    const realRename = fs.rename.bind(fs);
    const realRenameSync = fsSync.renameSync.bind(fsSync);
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const rename = vi.spyOn(fs, "rename").mockImplementation((from, to) => {
      denyInitialBackupRename(from, to);
      return realRename(from, to);
    });
    const renameSync = vi.spyOn(fsSync, "renameSync").mockImplementation((from, to) => {
      denyInitialBackupRename(from, to);
      return realRenameSync(from, to);
    });
    let result;
    try {
      result = await installPackageDir({
        ...updateOptions(sourceDir, targetDir),
        sourceHardlinks: "package-manager",
      });
    } finally {
      rename.mockRestore();
      renameSync.mockRestore();
      platform.mockRestore();
    }
    expect(denied).toBe(true);
    expect(result.ok).toBe(true);
    expect(await fs.readFile(path.join(targetDir, "marker.txt"), "utf8")).toBe("new");
  });

  it("preserves the canonical tree when ownership closes after backup copy publication", async () => {
    const { sourceDir, targetDir } = await createFixture("backup-copy-owner");
    const expired = new Error("install owner expired after backup publication");
    let ownerActive = true;
    let revoked = false;
    let treeAtRevocation: Record<string, string> | undefined;
    const readTargetTree = async () => {
      const entries = await fs.readdir(targetDir, { recursive: true, withFileTypes: true });
      return Object.fromEntries(
        await Promise.all(
          entries
            .filter((entry) => entry.isFile())
            .map(async (entry) => {
              const file = path.join(entry.parentPath, entry.name);
              return [path.relative(targetDir, file), await fs.readFile(file, "utf8")];
            }),
        ),
      );
    };
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
      await realRename(...args);
      if (
        !revoked &&
        path.basename(String(args[0])).startsWith(".fs-safe-move-") &&
        path.basename(path.dirname(String(args[1]))) === ".openclaw-install-backups"
      ) {
        await fs.mkdir(targetDir, { recursive: true });
        await fs.writeFile(path.join(targetDir, "successor.txt"), "successor-owned");
        treeAtRevocation = await readTargetTree();
        ownerActive = false;
        revoked = true;
      }
    });

    const result = await installPackageDir(
      requestDeferredPackageDirInstall(updateOptions(sourceDir, targetDir), () => {
        if (!ownerActive) {
          throw expired;
        }
      }),
    );

    expect(revoked).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(expired.message);
    }
    expect(await readTargetTree()).toEqual(treeAtRevocation);
  });

  it.each(["install", "update"] as const)(
    "preserves a successor when an earlier %s rollback finishes delayed removal",
    async (mode) => {
      const { fixtureRoot, sourceDir, targetDir } = await createFixture("rollback-removal-owner");
      if (mode === "install") {
        await fs.rm(targetDir, { recursive: true });
      }
      const leaseOptions = {
        path: path.join(fixtureRoot, "leases.sqlite"),
        leaseMs: 300_000,
        waitMs: 0,
      };
      const installOptions = {
        ...updateOptions(sourceDir, targetDir),
        mode,
      };
      const paused = createDeferred();
      const release = createDeferred();
      let originalBackup = "";
      let rollback = Promise.resolve();

      const original = withPluginLifecycleLease(leaseOptions, async (lease) => {
        const assertOwned = lease.assertOwned.bind(lease);
        const result = await installPackageDir(
          requestDeferredPackageDirInstall(
            {
              ...installOptions,
              afterBackup: async (backupDir: string) => {
                originalBackup = backupDir;
                return { ok: true as const };
              },
            },
            assertOwned,
          ),
        );
        expect(result.ok).toBe(true);
        const transaction = resolvePackageDirInstallTransaction(result);
        if (!transaction) {
          throw new Error("Expected a retained package transaction");
        }
        const publishedIdentity = await fs.lstat(targetDir, { bigint: true });
        let pauseConsumed = false;
        __setFsSafeTestHooksForTest({
          beforeRootFallbackMutation: async (operation, target) => {
            const candidate = fsSync.lstatSync(path.dirname(target), {
              bigint: true,
              throwIfNoEntry: false,
            });
            if (
              !pauseConsumed &&
              operation === "remove" &&
              candidate?.dev === publishedIdentity.dev &&
              candidate.ino === publishedIdentity.ino
            ) {
              pauseConsumed = true;
              paused.resolve();
              await release.promise;
            }
          },
        });
        rollback = transaction.rollback();
        void rollback.catch(() => undefined);
        await Promise.race([
          paused.promise,
          rollback.then(() => {
            throw new Error("rollback completed before recursive removal paused");
          }),
        ]);
        // A retained operation can outlive its lease; B must never inherit A's cleanup.
        return { assertOwned };
      });
      try {
        const closed = await original;
        expect(closed.assertOwned).toThrow();
        await fs.writeFile(path.join(sourceDir, "marker.txt"), "successor");
        await withPluginLifecycleLease(leaseOptions, async (lease) => {
          const successor = await installPackageDir({
            ...installOptions,
            mode: "update",
            beforePersistentApply: lease.assertOwned.bind(lease),
          });
          expect(successor.ok).toBe(true);
          const successorIdentity = await fs.lstat(targetDir, { bigint: true });
          release.resolve();
          await rollback.catch(() => undefined);
          lease.assertOwned();
          await expect(fs.readFile(path.join(targetDir, "marker.txt"), "utf8")).resolves.toBe(
            "successor",
          );
          await expect(fs.lstat(targetDir, { bigint: true })).resolves.toMatchObject({
            dev: successorIdentity.dev,
            ino: successorIdentity.ino,
          });
          if (mode === "update") {
            await expect(
              fs.readFile(path.join(originalBackup, "marker.txt"), "utf8"),
            ).resolves.toBe("old");
          }
        });
      } finally {
        release.resolve();
        await original.catch(() => undefined);
        await rollback.catch(() => undefined);
        closeOpenClawStateDatabaseForTest();
      }
    },
  );

  it.each(["removal", "restoration"] as const)(
    "retains rollback progress for a retry after %s fails",
    async (failure) => {
      const { installBaseDir, sourceDir, targetDir } = await createFixture("rollback-retry");
      const { backupDir, transaction } = await installRetainedUpdate(sourceDir, targetDir);
      const publishedIdentity = await fs.lstat(targetDir, { bigint: true });
      const ioError = Object.assign(new Error(`${failure} failed`), { code: "EIO" });
      let injected = false;
      const realRename = fs.rename.bind(fs);
      if (failure === "removal") {
        const prototype = Object.getPrototypeOf(await fsSafeRoot(installBaseDir)) as Root;
        // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted Root receiver to preserve its path and mutation authority.
        const remove = prototype.remove;
        vi.spyOn(prototype, "remove").mockImplementation(async function (
          this: Root,
          target,
          options,
        ) {
          const current = fsSync.lstatSync(path.dirname(path.join(this.rootReal, target)), {
            bigint: true,
            throwIfNoEntry: false,
          });
          if (
            !injected &&
            current?.dev === publishedIdentity.dev &&
            current.ino === publishedIdentity.ino
          ) {
            injected = true;
            throw ioError;
          }
          await remove.call(this, target, options);
        });
      } else {
        vi.spyOn(fs, "rename").mockImplementation((...args: Parameters<typeof fs.rename>) => {
          if (
            !injected &&
            normalizeComparablePath(String(args[1])) === normalizeComparablePath(targetDir)
          ) {
            injected = true;
            return Promise.reject(ioError);
          }
          return realRename(...args);
        });
      }

      const rollback = transaction.rollback();
      if (failure === "restoration") {
        await expect(rollback).rejects.toMatchObject({
          cause: ioError,
          message: expect.stringContaining(backupDir),
        });
      } else {
        await expect(rollback).rejects.toBe(ioError);
      }
      expect(injected).toBe(true);
      expect(await fs.readFile(path.join(backupDir, "marker.txt"), "utf8")).toBe("old");
      await transaction.rollback();
      expect(await fs.readFile(path.join(targetDir, "marker.txt"), "utf8")).toBe("old");
      expect(await fs.readdir(path.dirname(backupDir))).toEqual([]);
      expect(await listMatchingDirs(installBaseDir, ".openclaw-install-rollback-")).toEqual([]);
    },
  );

  it.each(["deferred", "immediate"] as const)(
    "stops %s backup retirement at the first refused leaf without swallowing an errno",
    async (settlement) => {
      await fixtureRootTracker.setup();
      const fixtureRoot = await fixtureRootTracker.make("backup-retirement-owner");
      const { sourceDir, targetDir } = await createExistingInstallFixture(fixtureRoot);
      await fs.writeFile(path.join(targetDir, "a.txt"), "first");
      await fs.writeFile(path.join(targetDir, "b.txt"), "retained");
      let backupDir = "";
      let published = false;
      let publishedIdentity: fsSync.BigIntStats | undefined;
      let armed = false;
      let refusals = 0;
      const refused = Object.assign(new Error("original retirement owner refused"), {
        code: "EIO",
      });
      const assertOwned = () => {
        if (armed && refusals === 0) {
          refusals += 1;
          throw refused;
        }
      };
      const rename = fs.rename.bind(fs);
      vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        await rename(from, to);
        if (normalizeComparablePath(String(to)) === normalizeComparablePath(targetDir)) {
          publishedIdentity = await fs.lstat(targetDir, { bigint: true });
          published = true;
        }
      });
      __setFsSafeTestHooksForTest({
        beforeRootFallbackMutation(operation, target) {
          if (
            published &&
            operation === "remove" &&
            normalizeComparablePath(target) ===
              normalizeComparablePath(path.join(backupDir, "b.txt"))
          ) {
            armed = true;
          }
        },
      });
      const params = {
        sourceDir,
        targetDir,
        mode: "update" as const,
        timeoutMs: 1_000,
        copyErrorPrefix: "failed to copy plugin",
        hasDeps: false,
        depsLogMessage: "",
        beforePersistentApply: assertOwned,
        afterBackup: async (directory: string) => {
          backupDir = directory;
          return { ok: true as const };
        },
      };
      const settleInstall = async () => {
        const result = await installPackageDir(
          settlement === "deferred"
            ? requestDeferredPackageDirInstall(params, assertOwned)
            : params,
        );
        expect(result.ok).toBe(true);
        if (settlement === "deferred") {
          const transaction = resolvePackageDirInstallTransaction(result);
          if (!transaction) {
            throw new Error("expected a retained update transaction");
          }
          await transaction.commit();
        }
      };

      await expect(settleInstall()).rejects.toBe(refused);

      expect(armed).toBe(true);
      expect(refusals).toBe(1);
      if (!publishedIdentity) {
        throw new Error("expected a published package identity");
      }
      expect(await fs.lstat(targetDir, { bigint: true })).toMatchObject({
        dev: publishedIdentity.dev,
        ino: publishedIdentity.ino,
      });
      expect(await fs.readFile(path.join(targetDir, "marker.txt"), "utf8")).toBe("new");
      expect(await fs.readFile(path.join(backupDir, "b.txt"), "utf8")).toBe("retained");
      await expect(fs.lstat(path.join(backupDir, "a.txt"))).rejects.toHaveProperty(
        "code",
        "ENOENT",
      );
    },
  );

  it.each([
    { name: "Error", refusal: new Error("retained owner closed") },
    { name: "false", refusal: false },
    {
      name: "errno",
      refusal: Object.assign(new Error("retained owner missing"), { code: "ENOENT" }),
    },
  ])(
    "keeps a one-shot $name transaction refusal across repeated commit and rollback",
    async ({ refusal }) => {
      await fixtureRootTracker.setup();
      const fixtureRoot = await fixtureRootTracker.make("retained-settlement-refusal");
      const { sourceDir, targetDir } = await createExistingInstallFixture(fixtureRoot);
      await fs.writeFile(path.join(targetDir, "a.txt"), "first");
      await fs.writeFile(path.join(targetDir, "b.txt"), "retained");
      let backupDir = "";
      let armed = false;
      let refusals = 0;
      const result = await installPackageDir(
        requestDeferredPackageDirInstall(
          {
            sourceDir,
            targetDir,
            mode: "update",
            timeoutMs: 1_000,
            copyErrorPrefix: "failed to copy plugin",
            hasDeps: false,
            depsLogMessage: "",
            afterBackup: async (directory: string) => {
              backupDir = directory;
              return { ok: true as const };
            },
          },
          () => {
            if (armed && refusals === 0) {
              refusals += 1;
              // oxlint-disable-next-line typescript/only-throw-error -- Non-Error owner refusals must retain their exact identity.
              throw refusal;
            }
          },
        ),
      );
      expect(result.ok).toBe(true);
      const transaction = resolvePackageDirInstallTransaction(result);
      if (!transaction) {
        throw new Error("expected a retained update transaction");
      }
      const liveIdentity = await fs.lstat(targetDir, { bigint: true });
      let injections = 0;
      __setFsSafeTestHooksForTest({
        beforeRootFallbackMutation(operation, target) {
          if (
            operation === "remove" &&
            normalizeComparablePath(target) ===
              normalizeComparablePath(path.join(backupDir, "b.txt"))
          ) {
            injections += 1;
            armed = true;
          }
        },
      });
      const unlink = vi.spyOn(fs, "unlink");
      const rmdir = vi.spyOn(fs, "rmdir");
      const rename = vi.spyOn(fs, "rename");
      const renameSync = vi.spyOn(fsSync, "renameSync");

      await expect(transaction.commit()).rejects.toBe(refusal);
      expect(injections).toBe(1);
      expect(refusals).toBe(1);
      expect(unlink).toHaveBeenCalledOnce();
      await expect(fs.lstat(path.join(backupDir, "a.txt"))).rejects.toHaveProperty(
        "code",
        "ENOENT",
      );

      for (const action of ["commit", "rollback", "commit", "rollback"] as const) {
        await expect(transaction[action]()).rejects.toBe(refusal);
      }

      expect(injections).toBe(1);
      expect(refusals).toBe(1);
      expect(unlink).toHaveBeenCalledOnce();
      expect(rmdir).not.toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();
      expect(renameSync).not.toHaveBeenCalled();
      expect(await fs.lstat(targetDir, { bigint: true })).toMatchObject({
        dev: liveIdentity.dev,
        ino: liveIdentity.ino,
      });
      expect(await fs.readFile(path.join(targetDir, "marker.txt"), "utf8")).toBe("new");
      expect(await fs.readFile(path.join(backupDir, "b.txt"), "utf8")).toBe("retained");
      expect(await fs.readFile(path.join(backupDir, "marker.txt"), "utf8")).toBe("old");
    },
  );

  it("retains one synchronous TypeError across settlement after an owner returns a Promise once", async () => {
    await fixtureRootTracker.setup();
    const fixtureRoot = await fixtureRootTracker.make("retained-async-settlement");
    const { sourceDir, targetDir } = await createExistingInstallFixture(fixtureRoot);
    await fs.writeFile(path.join(targetDir, "a.txt"), "first");
    await fs.writeFile(path.join(targetDir, "b.txt"), "retained");
    let backupDir = "";
    let armed = false;
    let refusals = 0;
    const result = await installPackageDir(
      requestDeferredPackageDirInstall(
        {
          sourceDir,
          targetDir,
          mode: "update",
          timeoutMs: 1_000,
          copyErrorPrefix: "failed to copy plugin",
          hasDeps: false,
          depsLogMessage: "",
          afterBackup: async (directory: string) => {
            backupDir = directory;
            return { ok: true as const };
          },
        },
        (): unknown => {
          if (armed && refusals === 0) {
            refusals += 1;
            return Promise.resolve();
          }
          return undefined;
        },
      ),
    );
    expect(result.ok).toBe(true);
    const transaction = resolvePackageDirInstallTransaction(result);
    if (!transaction) {
      throw new Error("expected a retained update transaction");
    }
    const liveIdentity = await fs.lstat(targetDir, { bigint: true });
    let injections = 0;
    __setFsSafeTestHooksForTest({
      beforeRootFallbackMutation(operation, target) {
        if (
          operation === "remove" &&
          normalizeComparablePath(target) === normalizeComparablePath(path.join(backupDir, "b.txt"))
        ) {
          injections += 1;
          armed = true;
        }
      },
    });
    const unlink = vi.spyOn(fs, "unlink");
    const rmdir = vi.spyOn(fs, "rmdir");
    const rename = vi.spyOn(fs, "rename");
    const renameSync = vi.spyOn(fsSync, "renameSync");
    const refusal = await transaction.commit().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(TypeError);
    expect(injections).toBe(1);
    expect(refusals).toBe(1);
    expect(unlink).toHaveBeenCalledOnce();
    await expect(fs.lstat(path.join(backupDir, "a.txt"))).rejects.toHaveProperty("code", "ENOENT");
    for (const action of ["commit", "rollback", "commit", "rollback"] as const) {
      await expect(transaction[action]()).rejects.toBe(refusal);
    }

    expect(injections).toBe(1);
    expect(refusals).toBe(1);
    expect(unlink).toHaveBeenCalledOnce();
    expect(rmdir).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(renameSync).not.toHaveBeenCalled();
    expect(await fs.lstat(targetDir, { bigint: true })).toMatchObject({
      dev: liveIdentity.dev,
      ino: liveIdentity.ino,
    });
    expect(await fs.readFile(path.join(targetDir, "marker.txt"), "utf8")).toBe("new");
    expect(await fs.readFile(path.join(backupDir, "b.txt"), "utf8")).toBe("retained");
    expect(await fs.readFile(path.join(backupDir, "marker.txt"), "utf8")).toBe("old");
  });

  it("does not clean a replacement quarantine or restore over it after private custody changes", async () => {
    await fixtureRootTracker.setup();
    const fixtureRoot = await fixtureRootTracker.make("rollback-private-owner");
    const { sourceDir, targetDir } = await createExistingInstallFixture(fixtureRoot);
    const retained = path.join(fixtureRoot, "retained-quarantine");
    let backupDir = "";
    const result = await installPackageDir(
      requestDeferredPackageDirInstall({
        sourceDir,
        targetDir,
        mode: "update",
        timeoutMs: 1_000,
        copyErrorPrefix: "failed to copy plugin",
        hasDeps: false,
        depsLogMessage: "",
        afterBackup: async (directory: string) => {
          backupDir = directory;
          return { ok: true as const };
        },
      }),
    );
    expect(result.ok).toBe(true);
    const transaction = resolvePackageDirInstallTransaction(result);
    if (!transaction) {
      throw new Error("expected a retained update transaction");
    }
    let replaced = "";
    __setFsSafeTestHooksForTest({
      beforeRootFallbackMutation: async (operation, target) => {
        const quarantine = path.dirname(path.dirname(target));
        if (
          !replaced &&
          operation === "remove" &&
          path.basename(quarantine).startsWith(".openclaw-install-rollback-")
        ) {
          replaced = quarantine;
          await fs.rename(quarantine, retained);
          await fs.mkdir(path.join(quarantine, "package"), { recursive: true });
          await fs.writeFile(path.join(quarantine, "package", "marker.txt"), "foreign");
        }
      },
    });

    await expect(transaction.rollback()).rejects.toThrow("install directory changed");

    expect(replaced).not.toBe("");
    expect(await fs.readFile(path.join(replaced, "package", "marker.txt"), "utf8")).toBe("foreign");
    expect(await fs.readFile(path.join(retained, "package", "marker.txt"), "utf8")).toBe("new");
    expect(await fs.readFile(path.join(backupDir, "marker.txt"), "utf8")).toBe("old");
    await expect(fs.lstat(targetDir)).rejects.toHaveProperty("code", "ENOENT");
  });

  it.each([
    { action: "commit", sourceHardlinks: "package-manager" },
    { action: "rollback", sourceHardlinks: "package-manager" },
    { action: "commit", sourceHardlinks: "reject" },
    { action: "rollback", sourceHardlinks: "reject" },
  ] as const)(
    "preserves a substituted $sourceHardlinks backup when $action is requested",
    async ({ action, sourceHardlinks }) => {
      const { fixtureRoot, sourceDir, targetDir } = await createFixture("substituted-backup");
      const { backupDir, transaction } = await installRetainedUpdate(sourceDir, targetDir, {
        sourceHardlinks,
      });
      const retainedBackup = path.join(fixtureRoot, "retained-backup");
      await fs.rename(backupDir, retainedBackup);
      await fs.mkdir(backupDir);
      await fs.writeFile(path.join(backupDir, "marker.txt"), "foreign backup");

      await expect(transaction[action]()).rejects.toThrow("install directory changed");
      expect(await fs.readFile(path.join(backupDir, "marker.txt"), "utf8")).toBe("foreign backup");
      expect(await fs.readFile(path.join(retainedBackup, "marker.txt"), "utf8")).toBe("old");
      expect(await fs.readFile(path.join(targetDir, "marker.txt"), "utf8")).toBe("new");

      await fs.rm(backupDir, { recursive: true });
      await fs.rename(retainedBackup, backupDir);
      await transaction[action]();
      expect(await fs.readFile(path.join(targetDir, "marker.txt"), "utf8")).toBe(
        action === "commit" ? "new" : "old",
      );
    },
  );

  it.each(["dev", "ino"] as const)(
    "preserves the published tree when Windows reports an unknown %s during rollback",
    async (field) => {
      const { sourceDir, targetDir } = await createFixture("rollback-unknown-identity");
      const { backupDir, transaction } = await installRetainedUpdate(sourceDir, targetDir, {
        sourceHardlinks: "package-manager",
      });
      const realLstat = fsSync.lstatSync.bind(fsSync);
      const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const lstat = vi.spyOn(fsSync, "lstatSync").mockImplementation((candidate, options) => {
        const current = realLstat(candidate, options);
        if (
          normalizeComparablePath(String(candidate)) === normalizeComparablePath(targetDir) &&
          current &&
          typeof current.dev === "bigint"
        ) {
          Object.defineProperty(current, field, { value: 0n });
        }
        return current;
      });
      try {
        await expect(transaction.rollback()).rejects.toThrow("install directory changed");
      } finally {
        lstat.mockRestore();
        platform.mockRestore();
      }
      expect(await fs.readFile(path.join(targetDir, "marker.txt"), "utf8")).toBe("new");
      expect(await fs.readFile(path.join(backupDir, "marker.txt"), "utf8")).toBe("old");
      await transaction.rollback();
      expect(await fs.readFile(path.join(targetDir, "marker.txt"), "utf8")).toBe("old");
    },
  );

  it("preserves a replacement inode while the original rollback owner remains live", async () => {
    const { fixtureRoot, sourceDir, targetDir } = await createFixture("rollback-inode");
    const preservedDir = path.join(fixtureRoot, "preserved-install");
    let backupDir = "";
    try {
      await withPluginLifecycleLease(
        { path: path.join(fixtureRoot, "leases.sqlite"), leaseMs: 300_000, waitMs: 0 },
        async (lease) => {
          const result = await installPackageDir(
            requestDeferredPackageDirInstall(
              {
                ...updateOptions(sourceDir, targetDir),
                afterBackup: async (directory: string) => {
                  backupDir = directory;
                  return { ok: true as const };
                },
              },
              lease.assertOwned.bind(lease),
            ),
          );
          expect(result.ok).toBe(true);
          const transaction = resolvePackageDirInstallTransaction(result);
          if (!transaction) {
            throw new Error("Expected a retained package transaction");
          }
          await fs.rename(targetDir, preservedDir);
          await fs.mkdir(targetDir);
          await fs.writeFile(path.join(targetDir, "marker.txt"), "replacement");
          const replacementIdentity = await fs.lstat(targetDir, { bigint: true });
          lease.assertOwned();

          await expect(transaction.rollback()).rejects.toThrow("install directory changed");
          expect(await fs.readFile(path.join(targetDir, "marker.txt"), "utf8")).toBe("replacement");
          expect(await fs.lstat(targetDir, { bigint: true })).toMatchObject({
            dev: replacementIdentity.dev,
            ino: replacementIdentity.ino,
          });
          expect(await fs.readFile(path.join(preservedDir, "marker.txt"), "utf8")).toBe("new");
          expect(await fs.readFile(path.join(backupDir, "marker.txt"), "utf8")).toBe("old");
        },
      );
    } finally {
      closeOpenClawStateDatabaseForTest();
    }
  });
});
