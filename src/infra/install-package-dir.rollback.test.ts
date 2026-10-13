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
    assertOwned?: () => void,
  ) {
    let backupDir = "";
    const result = await installPackageDir(
      requestDeferredPackageDirInstall(
        {
          ...updateOptions(sourceDir, targetDir),
          ...options,
          afterBackup: async (directory: string) => {
            backupDir = directory;
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
    return { backupDir, transaction };
  }

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

  it("preserves a successor when an earlier update rollback finishes delayed removal", async () => {
    const { fixtureRoot, sourceDir, targetDir } = await createFixture("rollback-removal-owner");
    const leaseOptions = {
      path: path.join(fixtureRoot, "leases.sqlite"),
      leaseMs: 300_000,
      waitMs: 0,
    };
    const installOptions = updateOptions(sourceDir, targetDir);
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
        await expect(fs.readFile(path.join(originalBackup, "marker.txt"), "utf8")).resolves.toBe(
          "old",
        );
      });
    } finally {
      release.resolve();
      await original.catch(() => undefined);
      await rollback.catch(() => undefined);
      closeOpenClawStateDatabaseForTest();
    }
  });

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

  it("stops immediate backup retirement at the first refused leaf without swallowing an errno", async () => {
    const { sourceDir, targetDir } = await createFixture("backup-retirement-owner");
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
          normalizeComparablePath(target) === normalizeComparablePath(path.join(backupDir, "b.txt"))
        ) {
          armed = true;
        }
      },
    });
    const params = {
      ...updateOptions(sourceDir, targetDir),
      beforePersistentApply: assertOwned,
      afterBackup: async (directory: string) => {
        backupDir = directory;
        return { ok: true as const };
      },
    };
    await expect(installPackageDir(params)).rejects.toBe(refused);

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
    await expect(fs.lstat(path.join(backupDir, "a.txt"))).rejects.toHaveProperty("code", "ENOENT");
  });

  it.each([
    { name: "false", refusal: false },
    {
      name: "errno",
      refusal: Object.assign(new Error("retained owner missing"), { code: "ENOENT" }),
    },
    { name: "Promise", refusal: undefined },
  ])(
    "keeps a one-shot $name transaction refusal across repeated commit and rollback",
    async ({ refusal }) => {
      const { sourceDir, targetDir } = await createFixture("retained-settlement-refusal");
      await fs.writeFile(path.join(targetDir, "a.txt"), "first");
      await fs.writeFile(path.join(targetDir, "b.txt"), "retained");
      let armed = false;
      let refusals = 0;
      const { backupDir, transaction } = await installRetainedUpdate(
        sourceDir,
        targetDir,
        {},
        (): unknown => {
          if (armed && refusals === 0) {
            refusals += 1;
            if (refusal === undefined) {
              return Promise.resolve();
            }
            // oxlint-disable-next-line typescript/only-throw-error -- Non-Error owner refusals must retain their exact identity.
            throw refusal;
          }
          return undefined;
        },
      );
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

      const firstRefusal = await transaction.commit().then(
        () => undefined,
        (error: unknown) => error,
      );
      if (refusal === undefined) {
        expect(firstRefusal).toBeInstanceOf(TypeError);
      } else {
        expect(firstRefusal).toBe(refusal);
      }
      expect(injections).toBe(1);
      expect(refusals).toBe(1);
      expect(unlink).toHaveBeenCalledOnce();
      await expect(fs.lstat(path.join(backupDir, "a.txt"))).rejects.toHaveProperty(
        "code",
        "ENOENT",
      );

      for (const action of ["commit", "rollback", "commit", "rollback"] as const) {
        await expect(transaction[action]()).rejects.toBe(firstRefusal);
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

  it("does not clean a replacement quarantine or restore over it after private custody changes", async () => {
    const { fixtureRoot, sourceDir, targetDir } = await createFixture("rollback-private-owner");
    const retained = path.join(fixtureRoot, "retained-quarantine");
    const { backupDir, transaction } = await installRetainedUpdate(sourceDir, targetDir);
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
    { replaced: "backup", action: "commit", sourceHardlinks: "package-manager" },
    { replaced: "backup", action: "rollback", sourceHardlinks: "reject" },
    { replaced: "install", action: "rollback", sourceHardlinks: "reject" },
  ] as const)(
    "preserves a substituted $sourceHardlinks $replaced when $action is requested",
    async ({ replaced, action, sourceHardlinks }) => {
      const { fixtureRoot, sourceDir, targetDir } = await createFixture("substituted-identity");
      const run = async (assertOwned?: () => void) => {
        const { backupDir, transaction } = await installRetainedUpdate(
          sourceDir,
          targetDir,
          { sourceHardlinks },
          assertOwned,
        );
        const substitutedDir = replaced === "backup" ? backupDir : targetDir;
        const retainedDir = path.join(fixtureRoot, "retained-original");
        const replacement = replaced === "backup" ? "foreign backup" : "replacement";
        await fs.rename(substitutedDir, retainedDir);
        await fs.mkdir(substitutedDir);
        await fs.writeFile(path.join(substitutedDir, "marker.txt"), replacement);
        const replacementIdentity =
          replaced === "install" ? await fs.lstat(targetDir, { bigint: true }) : undefined;
        assertOwned?.();

        await expect(transaction[action]()).rejects.toThrow("install directory changed");
        expect(await fs.readFile(path.join(substitutedDir, "marker.txt"), "utf8")).toBe(
          replacement,
        );
        expect(await fs.readFile(path.join(retainedDir, "marker.txt"), "utf8")).toBe(
          replaced === "backup" ? "old" : "new",
        );
        expect(
          await fs.readFile(
            path.join(replaced === "backup" ? targetDir : backupDir, "marker.txt"),
            "utf8",
          ),
        ).toBe(replaced === "backup" ? "new" : "old");

        if (replacementIdentity) {
          expect(await fs.lstat(targetDir, { bigint: true })).toMatchObject({
            dev: replacementIdentity.dev,
            ino: replacementIdentity.ino,
          });
        } else {
          await fs.rm(backupDir, { recursive: true });
          await fs.rename(retainedDir, backupDir);
          await transaction[action]();
          expect(await fs.readFile(path.join(targetDir, "marker.txt"), "utf8")).toBe(
            action === "commit" ? "new" : "old",
          );
        }
      };
      if (replaced === "backup") {
        await run();
      } else {
        try {
          await withPluginLifecycleLease(
            { path: path.join(fixtureRoot, "leases.sqlite"), leaseMs: 300_000, waitMs: 0 },
            async (lease) => run(lease.assertOwned.bind(lease)),
          );
        } finally {
          closeOpenClawStateDatabaseForTest();
        }
      }
    },
  );

  it("preserves the published tree when Windows reports an unknown inode during rollback", async () => {
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
        Object.defineProperty(current, "ino", { value: 0n });
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
  });

  it.each([
    { mode: "install", failure: "source cleanup" },
    { mode: "update", failure: "caller revocation" },
  ] as const)(
    "reverses an $mode publication when $failure fails with the lifecycle owner still active",
    async ({ mode, failure }) => {
      await fixtureRootTracker.setup();
      const fixtureRoot = await fixtureRootTracker.make("owned-publication-failure");
      const { sourceDir, targetDir } = await createExistingInstallFixture(fixtureRoot);
      if (mode === "install") {
        await fs.rm(targetDir, { recursive: true });
      }
      let stageDir = "";
      let published = false;
      let injected = false;
      let callerActive = true;
      const sourceCleanupError = Object.assign(new Error("published source cleanup failed"), {
        code: "EIO",
      });
      const callerError = new Error("initiating caller closed after publication");
      const realRename = fs.rename.bind(fs);
      vi.spyOn(fs, "rename").mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
        await realRename(...args);
        if (
          !published &&
          normalizeComparablePath(String(args[1])) === normalizeComparablePath(targetDir)
        ) {
          published = true;
          if (failure === "caller revocation") {
            callerActive = false;
            injected = true;
          }
        }
      });
      const realUnlink = fs.unlink.bind(fs);
      vi.spyOn(fs, "unlink").mockImplementation(async (...args: Parameters<typeof fs.unlink>) => {
        if (
          failure === "source cleanup" &&
          published &&
          !injected &&
          normalizeComparablePath(String(args[0])) ===
            normalizeComparablePath(path.join(stageDir, "marker.txt"))
        ) {
          injected = true;
          throw sourceCleanupError;
        }
        await realUnlink(...args);
      });

      const result = await installPackageDir(
        requestDeferredPackageDirInstall(
          {
            sourceDir,
            targetDir,
            mode,
            timeoutMs: 1_000,
            copyErrorPrefix: "failed to copy plugin",
            hasDeps: false,
            sourceHardlinks: "reject",
            depsLogMessage: "",
            afterCopy: (directory: string) => {
              stageDir = directory;
            },
            beforePersistentApply: () => {
              if (!callerActive) {
                throw callerError;
              }
            },
          },
          // Caller cancellation must not revoke the transaction owner's rollback authority.
          () => {},
        ),
      );

      expect(published).toBe(true);
      expect(injected).toBe(true);
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining(
          failure === "source cleanup" ? sourceCleanupError.message : callerError.message,
        ),
      });
      if (mode === "update") {
        expect(await fs.readFile(path.join(targetDir, "marker.txt"), "utf8")).toBe("old");
      } else {
        await expect(fs.lstat(targetDir)).rejects.toHaveProperty("code", "ENOENT");
      }
      expect(await fs.readFile(path.join(sourceDir, "marker.txt"), "utf8")).toBe("new");
    },
  );

  it("awaits planning hooks and restores the original after a publication assertion returns a Promise", async () => {
    await fixtureRootTracker.setup();
    const fixtureRoot = await fixtureRootTracker.make("async-publication-assertion");
    const { sourceDir, targetDir } = await createExistingInstallFixture(fixtureRoot);
    const original = await fs.lstat(targetDir, { bigint: true });
    const phases: string[] = [];
    let backupDir = "";
    let armed = false;
    let refusals = 0;
    const rename = vi.spyOn(fs, "rename");
    const result = await installPackageDir(
      requestDeferredPackageDirInstall(
        {
          sourceDir,
          targetDir,
          mode: "update",
          timeoutMs: 1_000,
          copyErrorPrefix: "failed to copy plugin",
          hasDeps: false,
          sourceHardlinks: "package-manager",
          depsLogMessage: "",
          afterCopy: async (directory: string) => {
            expect(await fs.readFile(path.join(directory, "marker.txt"), "utf8")).toBe("new");
            phases.push("copied");
          },
          afterInstall: async (directory: string) => {
            expect(await fs.readFile(path.join(directory, "marker.txt"), "utf8")).toBe("new");
            phases.push("installed");
            return { ok: true as const };
          },
          afterBackup: async (directory: string) => {
            backupDir = directory;
            expect(await fs.readFile(path.join(directory, "marker.txt"), "utf8")).toBe("old");
            phases.push("backed up");
            armed = true;
            return { ok: true as const };
          },
          beforePersistentApply(): unknown {
            if (armed) {
              refusals += 1;
              return Promise.resolve();
            }
            return undefined;
          },
        },
        // Publication-only refusal leaves the original transaction owner authorized to restore.
        () => {},
      ),
    );

    expect(phases).toEqual(["copied", "installed", "backed up"]);
    expect(result).toEqual({
      ok: false,
      error: "failed to copy plugin: TypeError: mutation authority must be synchronous",
    });
    expect(refusals).toBe(1);
    expect(
      rename.mock.calls.map(([from, to]) => [
        normalizeComparablePath(String(from)),
        normalizeComparablePath(String(to)),
      ]),
    ).toEqual([
      [normalizeComparablePath(targetDir), normalizeComparablePath(backupDir)],
      [normalizeComparablePath(backupDir), normalizeComparablePath(targetDir)],
    ]);
    expect(await fs.lstat(targetDir, { bigint: true })).toMatchObject({
      dev: original.dev,
      ino: original.ino,
    });
    expect(await fs.readFile(path.join(targetDir, "marker.txt"), "utf8")).toBe("old");
    expect(await fs.readFile(path.join(sourceDir, "marker.txt"), "utf8")).toBe("new");
    await expect(fs.lstat(backupDir)).rejects.toHaveProperty("code", "ENOENT");
  });

  it.each(["unchanged", "replaced", "replaced-during-cleanup", "backup removed"] as const)(
    "retries backup cleanup after restoration publication (%s)",
    async (retryState) => {
      await fixtureRootTracker.setup();
      const fixtureRoot = await fixtureRootTracker.make("restoration-cleanup-retry");
      const { sourceDir, targetDir } = await createExistingInstallFixture(fixtureRoot);
      await fs.writeFile(path.join(targetDir, "settings.json"), '{"original":true}\n');
      let backupDir = "";
      const installed = await installPackageDir(
        requestDeferredPackageDirInstall({
          sourceDir,
          targetDir,
          mode: "update",
          timeoutMs: 1_000,
          copyErrorPrefix: "failed to copy plugin",
          hasDeps: false,
          sourceHardlinks: "reject",
          depsLogMessage: "",
          afterBackup: async (directory: string) => {
            backupDir = directory;
            return { ok: true as const };
          },
        }),
      );
      expect(installed.ok).toBe(true);
      const transaction = resolvePackageDirInstallTransaction(installed);
      if (!transaction) {
        throw new Error("expected a retained update transaction");
      }
      let restored = false;
      let injected = false;
      const cleanupError = Object.assign(new Error("restored backup cleanup failed"), {
        code: "EIO",
      });
      const realRename = fs.rename.bind(fs);
      vi.spyOn(fs, "rename").mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
        await realRename(...args);
        if (normalizeComparablePath(String(args[1])) === normalizeComparablePath(targetDir)) {
          restored = true;
        }
      });
      const realUnlink = fs.unlink.bind(fs);
      vi.spyOn(fs, "unlink").mockImplementation(async (...args: Parameters<typeof fs.unlink>) => {
        if (
          restored &&
          !injected &&
          normalizeComparablePath(path.dirname(String(args[0]))) ===
            normalizeComparablePath(backupDir)
        ) {
          injected = true;
          throw cleanupError;
        }
        await realUnlink(...args);
      });

      const rollbackError = await transaction.rollback().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(restored).toBe(true);
      expect(injected).toBe(true);
      expect(String(rollbackError)).toContain(cleanupError.message);
      expect(String(rollbackError)).toContain("published");
      expect(String(rollbackError)).toContain(targetDir);
      expect(String(rollbackError)).toContain(backupDir);
      expect(await fs.readFile(path.join(targetDir, "marker.txt"), "utf8")).toBe("old");
      expect(await fs.readFile(path.join(targetDir, "settings.json"), "utf8")).toBe(
        '{"original":true}\n',
      );
      // The dependency's initial cleanup need not visit backup files in lexical order.
      expect(await fs.readFile(path.join(backupDir, "marker.txt"), "utf8")).toBe("old");
      expect(await fs.readFile(path.join(backupDir, "settings.json"), "utf8")).toBe(
        '{"original":true}\n',
      );

      const replaceTarget = async () => {
        await fs.rename(targetDir, path.join(fixtureRoot, "retained-original"));
        await fs.mkdir(targetDir);
        await fs.writeFile(path.join(targetDir, "marker.txt"), "successor");
      };
      if (retryState === "replaced") {
        await replaceTarget();
      } else if (retryState === "backup removed") {
        await fs.rm(backupDir, { recursive: true });
      }
      let targetIdentity = await fs.lstat(targetDir, { bigint: true });
      let replacedDuringCleanup = false;
      if (retryState === "replaced-during-cleanup") {
        __setFsSafeTestHooksForTest({
          beforeRootFallbackMutation: async (operation, target) => {
            if (
              !replacedDuringCleanup &&
              operation === "remove" &&
              normalizeComparablePath(target) ===
                normalizeComparablePath(path.join(backupDir, "settings.json"))
            ) {
              replacedDuringCleanup = true;
              await replaceTarget();
              targetIdentity = await fs.lstat(targetDir, { bigint: true });
            }
          },
        });
      }
      if (retryState === "unchanged" || retryState === "backup removed") {
        await transaction.rollback();
        await expect(fs.lstat(backupDir)).rejects.toHaveProperty("code", "ENOENT");
        expect(await fs.readFile(path.join(targetDir, "settings.json"), "utf8")).toBe(
          '{"original":true}\n',
        );
      } else {
        await expect(transaction.rollback()).rejects.toThrow();
        if (retryState === "replaced-during-cleanup") {
          expect(replacedDuringCleanup).toBe(true);
          expect(await fs.readFile(path.join(backupDir, "settings.json"), "utf8")).toBe(
            '{"original":true}\n',
          );
          await expect(fs.lstat(path.join(backupDir, "marker.txt"))).rejects.toHaveProperty(
            "code",
            "ENOENT",
          );
        } else {
          expect(await fs.readFile(path.join(backupDir, "marker.txt"), "utf8")).toBe("old");
        }
      }
      expect(await fs.readFile(path.join(targetDir, "marker.txt"), "utf8")).toBe(
        retryState === "replaced" || retryState === "replaced-during-cleanup" ? "successor" : "old",
      );
      expect(await fs.lstat(targetDir, { bigint: true })).toMatchObject({
        dev: targetIdentity.dev,
        ino: targetIdentity.ino,
      });
    },
  );

  it("retains and reports an update publication after the original lifecycle lease closes", async () => {
    await fixtureRootTracker.setup();
    const fixtureRoot = await fixtureRootTracker.make("revoked-publication-owner");
    const { sourceDir, targetDir } = await createExistingInstallFixture(fixtureRoot);
    const reachedPublication = createDeferred();
    const resumeCleanup = createDeferred();
    let published = false;
    let backupDir = "";
    let pendingInstall: ReturnType<typeof installPackageDir> | undefined;
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
      await realRename(...args);
      if (
        !published &&
        normalizeComparablePath(String(args[1])) === normalizeComparablePath(targetDir)
      ) {
        published = true;
        reachedPublication.resolve();
        await resumeCleanup.promise;
      }
    });

    const lifecycle = withPluginLifecycleLease(
      { path: path.join(fixtureRoot, "leases.sqlite"), leaseMs: 300_000, waitMs: 0 },
      async (lease) => {
        const assertOwned = lease.assertOwned.bind(lease);
        pendingInstall = installPackageDir(
          requestDeferredPackageDirInstall(
            {
              sourceDir,
              targetDir,
              mode: "update",
              timeoutMs: 1_000,
              copyErrorPrefix: "failed to copy plugin",
              hasDeps: false,
              sourceHardlinks: "reject",
              depsLogMessage: "",
              afterBackup: async (directory: string) => {
                backupDir = directory;
                return { ok: true as const };
              },
            },
            assertOwned,
          ),
        );
        await Promise.race([
          reachedPublication.promise,
          pendingInstall.then(() => {
            throw new Error("install finished before publication paused");
          }),
        ]);
        return assertOwned;
      },
    );

    try {
      const assertClosedOwner = await lifecycle;
      expect(assertClosedOwner).toThrow();
      const publishedIdentity = await fs.lstat(targetDir, { bigint: true });
      resumeCleanup.resolve();
      if (!pendingInstall) {
        throw new Error("expected an in-flight install");
      }
      const result = await pendingInstall;
      expect(published).toBe(true);
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("expected closed lifecycle ownership to reject source cleanup");
      }
      expect.soft(result.error).toContain("published");
      expect.soft(result.error).toContain(targetDir);
      expect(await fs.readFile(path.join(targetDir, "marker.txt"), "utf8")).toBe("new");
      expect(await fs.lstat(targetDir, { bigint: true })).toMatchObject({
        dev: publishedIdentity.dev,
        ino: publishedIdentity.ino,
      });
      expect(backupDir).not.toBe("");
      expect.soft(result.error).toContain(backupDir);
      expect(await fs.readFile(path.join(backupDir, "marker.txt"), "utf8")).toBe("old");
    } finally {
      resumeCleanup.resolve();
      await lifecycle.catch(() => undefined);
      await pendingInstall?.catch(() => undefined);
      closeOpenClawStateDatabaseForTest();
    }
  });
});
