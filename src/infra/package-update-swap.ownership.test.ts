import { randomUUID } from "node:crypto";
import fsSync, { unlinkSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  openPackageActivationJournal,
  resolvePackageActivationAnchor,
  type PackageActivationJournal,
} from "./package-update-activation-journal.js";
import { swapStagedPackageInstall, type PackageUpdateTransaction } from "./package-update-swap.js";
import {
  createPackageSwapFixture,
  createRetainedPackageSwap,
} from "./package-update-swap.test-support.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import {
  captureManagedUpdateLeaseDatabaseIdentity,
  createManagedHandoffLeaseDatabase,
} from "./update-managed-service-handoff-database.js";
import type { UpdateRecoveryFence } from "./update-run-recovery.js";

afterEach(() => vi.restoreAllMocks());

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type JournaledSwap = Awaited<ReturnType<typeof createPackageSwapFixture>> & {
  transaction: PackageUpdateTransaction;
  anchor: string;
  journal: PackageActivationJournal;
  fence: UpdateRecoveryFence;
  databasePath: string;
};

async function withJournaledSwap(run: (fixture: JournaledSwap) => Promise<void>) {
  const base = await fs.realpath(tempDirs.make("openclaw-journal-retirement-"));
  const fixture = await createPackageSwapFixture(base);
  const stageRoot = fixture.params.stage.packageRoot;
  const worker = runtimeProcessEntrypoints.updateMigratedFinalize;
  const checkPath = path.join(stageRoot, "dist", worker.distWorkerPath);
  await fs.mkdir(path.dirname(checkPath), { recursive: true });
  await fs.writeFile(
    path.join(stageRoot, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2.0.0", type: "module" }),
  );
  await fs.writeFile(
    checkPath,
    `await import(${JSON.stringify(resolveRuntimeWorkerUrl(worker).href)});\n`,
  );
  await writePackageDistInventory(stageRoot);
  const databasePath = path.join(base, "authority", "managed-update-handoffs.sqlite");
  createManagedHandoffLeaseDatabase(databasePath)(true, () => undefined);
  await withUpdateCommandExecutor(
    randomUUID(),
    async (executor) => {
      const fence = await executor.enter(fixture.packageRoot);
      let transaction: PackageUpdateTransaction | undefined;
      const result = await swapStagedPackageInstall({
        ...fixture.params,
        activation: { fence, nodeRunner: process.execPath, onPrepared: () => {} },
        onTransaction: (value) => {
          transaction = value;
        },
      });
      expect(result.status, result.step.stderrTail ?? undefined).toBe("committed");
      if (!transaction) {
        throw new Error("Journaled swap did not retain its transaction");
      }
      const anchor = resolvePackageActivationAnchor(fixture.packageRoot);
      const journal = openPackageActivationJournal(anchor);
      expect(journal.read().phase).toBe("publication-complete");
      await run({ ...fixture, transaction, anchor, journal, fence, databasePath });
    },
    {
      existingAuthority: {
        ...captureManagedUpdateLeaseDatabaseIdentity(databasePath),
        installKey: fixture.packageRoot,
      },
    },
  );
}

describe.runIf(process.platform !== "win32" && !process.versions.bun)(
  "journaled package transaction retirement",
  () => {
    it("shares concurrent retirement and returns only after final anchor removal settles", async () => {
      await withJournaledSwap(async ({ transaction, anchor, packageRoot, launcher, fence }) => {
        const entered = createDeferred();
        const release = createDeferred();
        const rmdir = fs.rmdir.bind(fs);
        const rmdirSpy = vi.spyOn(fs, "rmdir").mockImplementation(async (...args) => {
          await rmdir(...args);
          if (String(args[0]) === anchor) {
            entered.resolve();
            await release.promise;
          }
        });
        const rm = vi.spyOn(fs, "rm");
        const first = transaction.complete({ activationVerified: true }, fence.assertCurrent);
        const firstSettled = vi.fn();
        void first.then(firstSettled, firstSettled);
        let second: ReturnType<PackageUpdateTransaction["complete"]> | undefined;
        try {
          await Promise.race([entered.promise, first]);
          expect(rmdirSpy.mock.calls.filter(([target]) => String(target) === anchor)).toHaveLength(
            1,
          );
          await expect(fs.lstat(anchor)).rejects.toMatchObject({ code: "ENOENT" });
          second = transaction.complete({ activationVerified: true }, fence.assertCurrent);
          const secondSettled = vi.fn();
          void second.then(secondSettled, secondSettled);
          await Promise.resolve();
          expect(firstSettled).not.toHaveBeenCalled();
          expect(secondSettled).not.toHaveBeenCalled();
        } finally {
          release.resolve();
          await Promise.allSettled([first, ...(second ? [second] : [])]);
        }
        await expect(first).resolves.toBeUndefined();
        await expect(second).resolves.toBeUndefined();
        expect(rmdirSpy.mock.calls.filter(([target]) => String(target) === anchor)).toHaveLength(1);
        expect(
          rm.mock.calls.filter(([target]) => String(target) === transaction.backupRoot),
        ).toHaveLength(1);
        await expect(
          fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        ).resolves.toContain('"version":"2.0.0"');
        await expect(fs.readFile(launcher, "utf8")).resolves.toBe("candidate launcher\n");
      });
    });

    it("retires once when two completions await the same in-flight rollback", async () => {
      await withJournaledSwap(
        async ({ transaction, anchor, journal, packageRoot, launcher, fence }) => {
          const entered = createDeferred();
          const release = createDeferred();
          const rename = fs.rename.bind(fs);
          const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
            if (String(args[0]) === transaction.backupRoot && String(args[1]) === packageRoot) {
              entered.resolve();
              await release.promise;
            }
            return rename(...args);
          });
          const rmdir = vi.spyOn(fs, "rmdir");
          const rollback = transaction.rollback(fence.assertCurrent);
          const completions: ReturnType<PackageUpdateTransaction["complete"]>[] = [];
          try {
            await Promise.race([entered.promise, rollback]);
            expect(journal.read().phase).toBe("rollback-in-progress");
            expect(transaction.rollback(fence.assertCurrent)).toBe(rollback);
            completions.push(
              transaction.complete({ activationVerified: false }, fence.assertCurrent),
              transaction.complete({ activationVerified: false }, fence.assertCurrent),
            );
            expect(rmdir.mock.calls.filter(([target]) => String(target) === anchor)).toEqual([]);
          } finally {
            release.resolve();
            await Promise.allSettled([rollback, ...completions]);
          }
          await expect(rollback).resolves.toMatchObject({ exitCode: 0 });
          await expect(Promise.all(completions)).resolves.toEqual([undefined, undefined]);
          expect(
            renameSpy.mock.calls.filter(
              ([source, destination]) =>
                String(source) === transaction.backupRoot && String(destination) === packageRoot,
            ),
          ).toHaveLength(1);
          expect(rmdir.mock.calls.filter(([target]) => String(target) === anchor)).toHaveLength(1);
          await expect(fs.lstat(anchor)).rejects.toMatchObject({ code: "ENOENT" });
          await expect(
            fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
          ).resolves.toContain('"version":"1.0.0"');
          await expect(fs.readFile(launcher, "utf8")).resolves.toBe("old launcher\n");
        },
      );
    });

    it("caches a failed retirement after the filesystem recovers and refuses rollback", async () => {
      await withJournaledSwap(
        async ({ transaction, anchor, journal, packageRoot, launcher, fence }) => {
          const failure = Object.assign(new Error("retirement removal denied"), { code: "EACCES" });
          const rm = fs.rm.bind(fs);
          const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
            if (String(args[0]) === transaction.backupRoot) {
              throw failure;
            }
            return rm(...args);
          });
          const packageIdentity = (await fs.lstat(packageRoot)).ino;
          const launcherIdentity = (await fs.lstat(launcher)).ino;
          const completions = await Promise.allSettled([
            transaction.complete({ activationVerified: true }, fence.assertCurrent),
            transaction.complete({ activationVerified: true }, fence.assertCurrent),
          ]);
          for (const completion of completions) {
            expect(completion.status).toBe("rejected");
            if (completion.status === "rejected") {
              expect(completion.reason).toBe(failure);
            }
          }
          expect(
            rmSpy.mock.calls.filter(([target]) => String(target) === transaction.backupRoot),
          ).toHaveLength(1);
          rmSpy.mockRestore();
          const retained = journal.read();
          expect(retained).toMatchObject({
            phase: "retiring",
            intent: { kind: "remove", name: "previous", selected: "candidate" },
          });
          const artifacts = await fs.readdir(anchor);
          const rename = vi.spyOn(fs, "rename");
          const remove = vi.spyOn(fs, "rm");
          await expect(
            transaction.complete({ activationVerified: true }, fence.assertCurrent),
          ).rejects.toBe(failure);
          await expect(transaction.rollback(fence.assertCurrent)).resolves.toMatchObject({
            exitCode: 1,
            stderrTail: expect.stringContaining("retirement"),
          });
          expect(rename).not.toHaveBeenCalled();
          expect(remove).not.toHaveBeenCalled();
          expect(journal.read()).toEqual(retained);
          expect(await fs.readdir(anchor)).toEqual(artifacts);
          expect((await fs.lstat(packageRoot)).ino).toBe(packageIdentity);
          expect((await fs.lstat(launcher)).ino).toBe(launcherIdentity);
          await expect(
            fs.readFile(path.join(transaction.backupRoot, "package.json"), "utf8"),
          ).resolves.toContain('"version":"1.0.0"');
          await expect(
            fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
          ).resolves.toContain('"version":"2.0.0"');
          await expect(fs.readFile(launcher, "utf8")).resolves.toBe("candidate launcher\n");
        },
      );
    });

    it("keeps the original executor failure after final anchor removal sticky", async () => {
      await withJournaledSwap(
        async ({ transaction, anchor, packageRoot, launcher, fence, databasePath }) => {
          const rmdir = fs.rmdir.bind(fs);
          let failedLeasePath: string | undefined;
          const rmdirSpy = vi.spyOn(fs, "rmdir").mockImplementation(async (...args) => {
            await rmdir(...args);
            if (String(args[0]) === anchor) {
              // The native owner, not a replacement fence, decides that this
              // one unreadable lease observation cannot authorize success.
              vi.spyOn(fsSync, "realpathSync").mockImplementationOnce((target) => {
                failedLeasePath = String(target);
                throw Object.assign(new Error("lease identity read unavailable"), {
                  code: "EIO",
                });
              });
            }
          });
          const [outcome] = await Promise.allSettled([
            transaction.complete({ activationVerified: true }, fence.assertCurrent),
          ]);
          expect(rmdirSpy.mock.calls.filter(([target]) => String(target) === anchor)).toHaveLength(
            1,
          );
          expect(failedLeasePath).toBe(databasePath);
          if (outcome?.status !== "rejected") {
            throw new Error("Retirement succeeded without its final executor observation");
          }
          expect(outcome.reason).toMatchObject({
            message: expect.stringMatching(/executor ownership is no longer current/u),
          });
          expect(() => fence.assertCurrent()).not.toThrow();
          await expect(
            transaction.complete({ activationVerified: true }, fence.assertCurrent),
          ).rejects.toBe(outcome.reason);
          await expect(transaction.rollback(fence.assertCurrent)).resolves.toMatchObject({
            exitCode: 1,
          });
          expect(rmdirSpy.mock.calls.filter(([target]) => String(target) === anchor)).toHaveLength(
            1,
          );
          await expect(fs.lstat(anchor)).rejects.toMatchObject({ code: "ENOENT" });
          await expect(
            fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
          ).resolves.toContain('"version":"2.0.0"');
          await expect(fs.readFile(launcher, "utf8")).resolves.toBe("candidate launcher\n");
        },
      );
    });
  },
);

describe("retained package transaction authority", () => {
  it("stops a partial npm activation before launcher compensation after executor loss", async () => {
    await withTestDir({ prefix: "openclaw-partial-rollback-owner-" }, async (base) => {
      const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
      let transaction: PackageUpdateTransaction | undefined;
      const result = await swapStagedPackageInstall({
        ...params,
        onTransaction: (value) => {
          transaction = value;
          unlinkSync(path.join(params.stage.layout.binDir, "openclaw"));
        },
      });
      expect(result.status).toBe("failed");
      if (!transaction) {
        throw new Error("Missing retained partial activation");
      }
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
      const copy = vi.spyOn(fs, "copyFile");
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
      await expect(fs.readFile(path.join(candidate, "package.json"), "utf8")).resolves.toContain(
        '"version":"2.0.0"',
      );
      await expect(
        fs.readFile(path.join(transaction.backupRoot, "package.json"), "utf8"),
      ).resolves.toContain('"version":"1.0.0"');
    });
  });

  it.each(["integrity", "displacement", "compensation", "launcher", "retirement"] as const)(
    "stops rollback and preserves recovery material after ownership loss during %s",
    async (boundary) => {
      await withTestDir({ prefix: "openclaw-rollback-owner-" }, async (base) => {
        const { transaction, packageRoot, launcher, globalRoot } =
          await createRetainedPackageSwap(base);
        const candidate = `${transaction.backupRoot}.candidate`;
        const shimBackup = (await fs.readdir(globalRoot)).find((entry) =>
          entry.startsWith(".openclaw.shim-backup-"),
        )!;
        let current = true;
        const lost = new Error("original executor lost");
        const assertCurrent = () => {
          if (!current) {
            throw lost;
          }
        };
        const staleEffects: string[] = [];
        const record = (operation: string, destination: string) => {
          // Unpublished, operation-owned launcher scratch is disposable even
          // after revocation; live paths and retained evidence are not.
          if (!current && !destination.includes(".openclaw-shim-stage-")) {
            staleEffects.push(`${operation}: ${destination}`);
          }
        };
        const lstat = fs.lstat.bind(fs);
        vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
          const result = await lstat(...args);
          if (boundary === "integrity" && String(args[0]) === transaction.backupRoot) {
            current = false;
          }
          return result;
        });
        const rename = fs.rename.bind(fs);
        const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
          record("rename", String(args[1]));
          if (boundary === "compensation" && String(args[0]) === transaction.backupRoot) {
            current = false;
            throw Object.assign(new Error("restore denied"), { code: "EACCES" });
          }
          await rename(...args);
          if (boundary === "displacement" && String(args[0]) === packageRoot) {
            current = false;
          }
        });
        const copyFile = fs.copyFile.bind(fs);
        vi.spyOn(fs, "copyFile").mockImplementation(async (...args) => {
          record("copy", String(args[1]));
          await copyFile(...args);
          if (boundary === "launcher") {
            current = false;
          }
        });
        const chmod = fs.chmod.bind(fs);
        vi.spyOn(fs, "chmod").mockImplementation(async (...args) => {
          record("chmod", String(args[0]));
          return chmod(...args);
        });
        const rm = fs.rm.bind(fs);
        vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
          record("remove", String(args[0]));
          if (boundary === "retirement" && String(args[0]) === path.join(globalRoot, shimBackup)) {
            current = false;
            throw Object.assign(new Error("retirement denied"), { code: "EACCES" });
          }
          return rm(...args);
        });
        await expect(transaction.rollback(assertCurrent)).rejects.toBe(lost);
        expect(current).toBe(false);
        expect(staleEffects).toEqual([]);
        expect(() => transaction.rollback(() => {})).toThrow(lost);
        await expect(transaction.complete({ activationVerified: true }, () => {})).rejects.toBe(
          lost,
        );
        expect(staleEffects).toEqual([]);
        expect(await fs.readdir(path.dirname(launcher))).toEqual(["openclaw"]);
        await expect(fs.stat(path.join(globalRoot, shimBackup))).resolves.toBeDefined();
        if (boundary === "integrity") {
          await expect(
            fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
          ).resolves.toContain('"version":"2.0.0"');
          expect(renameSpy).not.toHaveBeenCalled();
        } else {
          await expect(
            fs.readFile(path.join(candidate, "package.json"), "utf8"),
          ).resolves.toContain('"version":"2.0.0"');
        }
        if (boundary === "displacement" || boundary === "compensation") {
          await expect(fs.lstat(packageRoot)).rejects.toMatchObject({ code: "ENOENT" });
        }
        const previous =
          boundary === "launcher" || boundary === "retirement"
            ? packageRoot
            : transaction.backupRoot;
        await expect(fs.readFile(path.join(previous, "package.json"), "utf8")).resolves.toContain(
          '"version":"1.0.0"',
        );
        await expect(fs.readFile(launcher, "utf8")).resolves.toBe(
          boundary === "retirement" ? "old launcher\n" : "candidate launcher\n",
        );
      });
    },
  );

  it("keeps the original completion authority through a failed backup removal", async () => {
    await withTestDir({ prefix: "openclaw-retirement-owner-" }, async (base) => {
      const { transaction, packageRoot } = await createRetainedPackageSwap(base);
      let current = true;
      const assertCurrent = () => {
        if (!current) {
          throw new Error("retirement executor lost");
        }
      };
      const rm = fs.rm.bind(fs);
      vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
        if (String(args[0]) === transaction.backupRoot) {
          current = false;
          throw Object.assign(new Error("remove denied"), { code: "EACCES" });
        }
        return rm(...args);
      });
      const rename = vi.spyOn(fs, "rename");
      await expect(
        transaction.complete({ activationVerified: true }, assertCurrent),
      ).rejects.toThrow("retirement executor lost");
      await expect(transaction.complete({ activationVerified: true }, () => {})).rejects.toThrow(
        "retirement executor lost",
      );
      expect(rename).not.toHaveBeenCalled();
      await expect(
        fs.readFile(path.join(transaction.backupRoot, "package.json"), "utf8"),
      ).resolves.toContain('"version":"1.0.0"');
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"version":"2.0.0"',
      );
    });
  });
});
