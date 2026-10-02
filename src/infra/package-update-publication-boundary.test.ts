import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../process/exec-result.js";
import * as nodeSqlite from "./node-sqlite.js";
import {
  openPackageActivationJournal,
  packageActivationIdentity,
  resolvePackageActivationAnchor,
  resolvePackageActivationControl,
  resolvePackageActivationJournalPath,
} from "./package-update-activation-journal.js";
import { createPackageActivationLifetimeFixture } from "./package-update-activation-lifetime.test-support.js";
import { packageActivationRuntimeForTest } from "./package-update-activation-runtime.test-support.js";
import { assertNoPendingPackageActivation } from "./package-update-activation.js";
import * as packageFilesystem from "./package-update-filesystem.js";
import { interceptPackageFileHashes } from "./package-update-integrity-hasher.test-support.js";
import { createNpmTarget, writePackageRoot } from "./package-update-steps.test-support.js";
import type { PackageUpdateTransaction } from "./package-update-swap-contract.js";
import { swapStagedPackageInstall } from "./package-update-swap.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";
import * as snapshot from "./sqlite-snapshot.js";
import { resolveUpdateInstallRoot } from "./update-install-root.js";
import { withRetainedUpdateRuntime } from "./update-retained-runtime.js";

const fixtures = createPackageActivationLifetimeFixture();
let root: string;
beforeEach(() => {
  ({ root } = fixtures.setup());
  const state = path.join(root, "state");
  fs.mkdirSync(state, { mode: 0o700 });
  vi.stubEnv("OPENCLAW_STATE_DIR", state);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(state, "openclaw.json"));
});
afterEach(async () => {
  try {
    await fixtures.lifetime.cleanup();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

it.skipIf(process.platform === "win32")(
  "accepts present and temporarily missing npm roots through a canonical directory alias",
  () =>
    fixtures.lifetime.run(async () => {
      const f = await createPackageSwapFixture(root);
      await fixtures.writePostCoreCapability(f.params.stage.packageRoot);
      const aliasPrefix = path.join(root, "live-alias");
      fs.symlinkSync(path.join(root, "live"), aliasPrefix, "dir");
      const aliasGlobalRoot = path.join(aliasPrefix, "lib", "node_modules");
      const aliasPackageRoot = path.join(aliasGlobalRoot, "openclaw");
      const absentAliasPackageRoot = path.join(aliasGlobalRoot, "absent-openclaw");
      expect(resolveUpdateInstallRoot(absentAliasPackageRoot)).toBe(
        path.join(fs.realpathSync.native(aliasGlobalRoot), "absent-openclaw"),
      );
      const danglingAliasPackageRoot = path.join(aliasGlobalRoot, "dangling-openclaw");
      fs.symlinkSync(path.join(root, "missing-target"), danglingAliasPackageRoot, "dir");
      expect(resolveUpdateInstallRoot(danglingAliasPackageRoot)).toBe(
        path.resolve(danglingAliasPackageRoot),
      );
      const installTarget = createNpmTarget(aliasGlobalRoot);
      await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(aliasPackageRoot);
        let transaction: PackageUpdateTransaction | undefined;
        const result = await swapStagedPackageInstall({
          ...f.params,
          installTarget,
          activation: { fence, runtime: packageActivationRuntimeForTest(), onPrepared: () => {} },
          onTransaction: (issued) => {
            transaction = issued;
          },
        });
        expect(result.status, result.step.stderrTail ?? undefined).toBe("committed");
        expect(transaction).toBeDefined();
        await transaction!.complete({ activationVerified: true }, fence.assertCurrent);
        expect(
          JSON.parse(fs.readFileSync(path.join(f.packageRoot, "package.json"), "utf8")),
        ).toEqual({ name: "openclaw", version: "2.0.0" });
      });
    }),
);

it.skipIf(process.platform === "win32").each(["owned", "replacement"] as const)(
  "completes real launcher publication and binds retirement to its %s directory",
  (retirement) =>
    fixtures.lifetime.run(async () => {
      const f = await createPackageSwapFixture(root);
      await fixtures.writePostCoreCapability(f.params.stage.packageRoot);
      fs.writeFileSync(path.join(f.packageRoot, "previous.payload"), "previous bytes");
      fs.writeFileSync(
        path.join(f.params.stage.packageRoot, "candidate.payload"),
        "candidate bytes",
      );
      const reads = { previous: 0, candidate: 0 };
      interceptPackageFileHashes((file, _stat, next) => {
        const name = path.basename(file);
        if (name === "previous.payload") {
          reads.previous++;
        }
        if (name === "candidate.payload") {
          reads.candidate++;
        }
        return next();
      });
      await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(f.packageRoot);
        let transaction: PackageUpdateTransaction | undefined;
        const result = await swapStagedPackageInstall({
          ...f.params,
          activation: { fence, runtime: packageActivationRuntimeForTest(), onPrepared: () => {} },
          onTransaction: (issued) => {
            transaction = issued;
          },
        });
        expect(result.status, result.step.stderrTail ?? undefined).toBe("committed");
        expect(fs.readFileSync(f.launcher, "utf8")).toBe("candidate launcher\n");
        expect(
          JSON.parse(fs.readFileSync(path.join(f.packageRoot, "package.json"), "utf8")).version,
        ).toBe("2.0.0");
        const anchor = resolvePackageActivationAnchor(f.packageRoot);
        const record = openPackageActivationJournal(anchor).read();
        expect(record.phase).toBe("publication-complete");
        expect(record.publications).toEqual([
          { name: "openclaw", identity: packageActivationIdentity(f.launcher, "launcher") },
        ]);
        expect(transaction).toBeDefined();
        expect(reads).toEqual({ previous: 2, candidate: 4 });
        if (retirement === "replacement") {
          const obsolete = path.join(anchor, "previous");
          const retained = path.join(root, "retained-previous");
          const remove = packageFilesystem.removePackagePath;
          vi.spyOn(packageFilesystem, "removePackagePath").mockImplementation(
            async (target, assertion) => {
              if (target === obsolete) {
                fs.renameSync(target, retained);
                fs.mkdirSync(target);
                fs.writeFileSync(path.join(target, "successor.txt"), "foreign retirement owner");
              }
              return remove(target, assertion);
            },
          );
          await expect(
            transaction!.complete({ activationVerified: true }, fence.assertCurrent),
          ).rejects.toThrow("Retirement target changed");
          expect(fs.readFileSync(path.join(obsolete, "successor.txt"), "utf8")).toBe(
            "foreign retirement owner",
          );
          expect(
            JSON.parse(fs.readFileSync(path.join(retained, "package.json"), "utf8")).version,
          ).toBe("1.0.0");
          expect(openPackageActivationJournal(anchor).read().intent).toMatchObject({
            kind: "remove",
            name: "previous",
          });
        } else {
          // Once the candidate is verified, obsolete backup bytes are not rollback input.
          fs.writeFileSync(path.join(anchor, "previous", "previous.payload"), "obsolete bytes");
          await transaction!.complete({ activationVerified: true }, fence.assertCurrent);
          expect(reads).toEqual({ previous: 2, candidate: 5 });
          expect(fs.existsSync(anchor)).toBe(false);
          // A completed transaction stays cached even after its one-slot receipt
          // is reused by another publication under the same executor.
          await writePackageRoot(f.params.stage.packageRoot, "3.0.0");
          await fixtures.writePostCoreCapability(f.params.stage.packageRoot);
          fs.mkdirSync(f.params.stage.layout.binDir, { recursive: true });
          fs.writeFileSync(
            path.join(f.params.stage.layout.binDir, "openclaw"),
            "candidate launcher\n",
          );
          let nextTransaction: PackageUpdateTransaction | undefined;
          const next = await swapStagedPackageInstall({
            ...f.params,
            activation: { fence, runtime: packageActivationRuntimeForTest(), onPrepared: () => {} },
            onTransaction: (issued) => {
              nextTransaction = issued;
            },
          });
          expect(next.status, next.step.stderrTail ?? undefined).toBe("committed");
          await expect(
            transaction!.complete({ activationVerified: true }, fence.assertCurrent),
          ).resolves.toBeUndefined();
          expect(openPackageActivationJournal(anchor).read().phase).toBe("publication-complete");
          await nextTransaction!.complete({ activationVerified: true }, fence.assertCurrent);
          expect(fs.existsSync(anchor)).toBe(false);
          expect(
            JSON.parse(fs.readFileSync(path.join(f.packageRoot, "package.json"), "utf8")).version,
          ).toBe("3.0.0");
        }
        expect(fs.readFileSync(f.launcher, "utf8")).toBe("candidate launcher\n");
      });
    }),
);

it.skipIf(process.platform === "win32").each(["activation", "publication", "retirement"] as const)(
  "refuses metadata-preserving candidate byte changes at %s",
  (boundary) =>
    fixtures.lifetime.run(async () => {
      const f = await createPackageSwapFixture(root);
      await fixtures.writePostCoreCapability(f.params.stage.packageRoot);
      const previousIdentity = packageActivationIdentity(f.packageRoot, true);
      const name = "mapped.payload";
      const staged = path.join(f.params.stage.packageRoot, name);
      fs.writeFileSync(staged, "previous bytes");
      const unchanged = fs.lstatSync(staged, { bigint: true });
      // A Linux writable mmap can change bytes without changing any stat field.
      // Reproduce those filesystem observations without a native mmap dependency.
      const lstat = fsp.lstat.bind(fsp);
      vi.spyOn(fsp, "lstat").mockImplementation((...args) =>
        path.basename(String(args[0])) === name && args[1]?.bigint
          ? Promise.resolve(unchanged)
          : lstat(...args),
      );
      let changedBytesRead = false;
      interceptPackageFileHashes(async (file, _stat, next) => {
        if (path.basename(file) === name) {
          const contents = fs.readFileSync(file);
          changedBytesRead ||= contents.toString() === "modified bytes";
          return createHash("sha256").update(contents).digest("hex");
        }
        return next();
      });
      const anchor = resolvePackageActivationAnchor(f.packageRoot);
      const change = (directory: string) =>
        fs.writeFileSync(path.join(directory, name), "modified bytes");
      const rename = fsp.rename.bind(fsp);
      vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
        await rename(from, to);
        if (
          boundary === "publication" &&
          from === path.join(anchor, "candidate") &&
          to === f.packageRoot
        ) {
          change(f.packageRoot);
        }
      });
      await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(f.packageRoot);
        let transaction: PackageUpdateTransaction | undefined;
        const result = await swapStagedPackageInstall({
          ...f.params,
          activation: { fence, runtime: packageActivationRuntimeForTest(), onPrepared: () => {} },
          beforeActivate: async () => {
            if (boundary === "activation") {
              change(path.join(anchor, "candidate"));
            }
          },
          onTransaction: (issued) => {
            transaction = issued;
          },
        });
        if (boundary === "retirement") {
          expect(result.status).toBe("committed");
          change(f.packageRoot);
          await expect(
            transaction!.complete({ activationVerified: true }, fence.assertCurrent),
          ).rejects.toThrow("Package publication object changed");
        } else {
          expect(result.status).toBe("failed");
          expect(result.step.stderrTail).toContain("Package publication object changed");
        }
        expect(changedBytesRead).toBe(true);
        if (boundary === "activation") {
          expect(packageActivationIdentity(f.packageRoot, true)).toBe(previousIdentity);
          expect(fs.readFileSync(f.launcher, "utf8")).toBe("old launcher\n");
          expect(fs.existsSync(path.join(anchor, "previous"))).toBe(false);
        }
        const previous = fs.existsSync(path.join(anchor, "previous"))
          ? path.join(anchor, "previous")
          : f.packageRoot;
        expect(fs.readFileSync(path.join(previous, "package.json"), "utf8")).toContain(
          '"version":"1.0.0"',
        );
        const candidate =
          boundary === "activation" ? path.join(anchor, "candidate") : f.packageRoot;
        expect(fs.readFileSync(path.join(candidate, name), "utf8")).toBe("modified bytes");
        expect(await fsp.lstat(path.join(candidate, name), { bigint: true })).toEqual(unchanged);
      });
    }),
);

it.skipIf(process.platform === "win32")(
  "admits a second publication after the live sibling refusal is resolved",
  () =>
    fixtures.lifetime.run(async () => {
      const f = await createPackageSwapFixture(root);
      await fixtures.writePostCoreCapability(f.params.stage.packageRoot);
      const refusal = new Error("A live sibling still uses this installation");
      const onTransaction = vi.fn();
      await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(f.packageRoot);
        await expect(
          swapStagedPackageInstall({
            ...f.params,
            activation: { fence, runtime: packageActivationRuntimeForTest(), onPrepared: () => {} },
            beforeActivate: async () => {
              throw refusal;
            },
            onTransaction,
          }),
        ).rejects.toMatchObject({ cause: refusal });
      });
      expect(onTransaction).not.toHaveBeenCalled();
      expect(fs.readFileSync(f.launcher, "utf8")).toBe("old launcher\n");
      expect(fs.readFileSync(path.join(f.packageRoot, "package.json"), "utf8")).toContain(
        '"version":"1.0.0"',
      );

      // The next invocation has a new executor and must pass the real admission
      // check before preparing another candidate in the same installation.
      assertNoPendingPackageActivation(f.packageRoot);
      await writePackageRoot(f.params.stage.packageRoot, "2.0.0");
      await fixtures.writePostCoreCapability(f.params.stage.packageRoot);
      fs.mkdirSync(f.params.stage.layout.binDir, { recursive: true });
      fs.writeFileSync(path.join(f.params.stage.layout.binDir, "openclaw"), "candidate launcher\n");
      await withRetainedUpdateRuntime(
        pathToFileURL(path.join(f.packageRoot, "dist/index.js")).href,
        async (retain) => {
          await withUpdateCommandExecutor(randomUUID(), async (executor) => {
            const fence = await executor.enter(f.packageRoot);
            await retain({
              mutationRoots: [f.packageRoot],
              installTarget: f.params.installTarget,
              timeoutMs: 30_000,
              assertCurrent: fence.assertCurrent,
            });
            const journal = resolvePackageActivationJournalPath(
              resolvePackageActivationAnchor(f.packageRoot),
            );
            expect(fs.statSync(journal).nlink).toBe(1);
            assertNoPendingPackageActivation(f.packageRoot);
            const result = await swapStagedPackageInstall({
              ...f.params,
              activation: {
                fence,
                runtime: packageActivationRuntimeForTest(),
                onPrepared: () => {},
              },
              beforeActivate: async () => {},
            });
            expect(result.status, result.step.stderrTail ?? undefined).toBe("committed");
          });
        },
      );
      assertNoPendingPackageActivation(f.packageRoot);
      expect(fs.readFileSync(f.launcher, "utf8")).toBe("candidate launcher\n");
      expect(fs.readFileSync(path.join(f.packageRoot, "package.json"), "utf8")).toContain(
        '"version":"2.0.0"',
      );
    }),
);

it.skipIf(process.platform === "win32")(
  "retains prepared recovery when the refused callback has unjoined work",
  () =>
    fixtures.lifetime.run(async () => {
      const f = await createPackageSwapFixture(root);
      await fixtures.writePostCoreCapability(f.params.stage.packageRoot);
      const uncertainty = new CommandProcessCleanupError();
      await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(f.packageRoot);
        await expect(
          swapStagedPackageInstall({
            ...f.params,
            activation: { fence, runtime: packageActivationRuntimeForTest(), onPrepared: () => {} },
            beforeActivate: async () => {
              throw uncertainty;
            },
          }),
        ).rejects.toSatisfy(hasCommandProcessCleanupError);
        const anchor = resolvePackageActivationAnchor(f.packageRoot);
        expect(openPackageActivationJournal(anchor).read().phase).toBe("prepared");
        expect(fs.readFileSync(path.join(anchor, "candidate", "package.json"), "utf8")).toContain(
          '"version":"2.0.0"',
        );
        expect(() => assertNoPendingPackageActivation(f.packageRoot)).toThrow(
          "Package publication is incomplete",
        );
      });
    }),
);

it.skipIf(process.platform === "win32")(
  "preserves a foreign replacement and both errors when refusal retirement loses its preimage",
  () =>
    fixtures.lifetime.run(async () => {
      const f = await createPackageSwapFixture(root);
      await fixtures.writePostCoreCapability(f.params.stage.packageRoot);
      const refusal = new Error("A live sibling still uses this installation");
      const previous = path.join(root, "previous-installation");
      await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(f.packageRoot);
        await expect(
          swapStagedPackageInstall({
            ...f.params,
            activation: { fence, runtime: packageActivationRuntimeForTest(), onPrepared: () => {} },
            beforeActivate: async () => {
              fs.renameSync(f.packageRoot, previous);
              await writePackageRoot(f.packageRoot, "3.0.0");
              throw refusal;
            },
          }),
        ).rejects.toMatchObject({
          cause: {
            cause: refusal,
            errors: [
              refusal,
              expect.objectContaining({
                message: "The installed package is not either recorded generation.",
              }),
            ],
          },
        });
        expect(fs.readFileSync(path.join(f.packageRoot, "package.json"), "utf8")).toContain(
          '"version":"3.0.0"',
        );
        expect(fs.readFileSync(path.join(previous, "package.json"), "utf8")).toContain(
          '"version":"1.0.0"',
        );
        expect(fs.readFileSync(f.launcher, "utf8")).toBe("old launcher\n");
        expect(
          openPackageActivationJournal(resolvePackageActivationAnchor(f.packageRoot)).read().phase,
        ).toBe("prepared");
      });
    }),
);

it.skipIf(process.platform === "win32")(
  "retires an untouched publication after its first package rename is refused",
  () =>
    fixtures.lifetime.run(async () => {
      const f = await createPackageSwapFixture(root);
      await fixtures.writePostCoreCapability(f.params.stage.packageRoot);
      await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(f.packageRoot);
        const anchor = resolvePackageActivationAnchor(f.packageRoot);
        const rename = fsp.rename.bind(fsp);
        let refused = false;
        vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
          if (!refused && from === f.packageRoot && to === path.join(anchor, "previous")) {
            refused = true;
            throw new Error("package displacement refused");
          }
          return rename(from, to);
        });
        let transaction: PackageUpdateTransaction | undefined;
        const result = await swapStagedPackageInstall({
          ...f.params,
          activation: { fence, runtime: packageActivationRuntimeForTest(), onPrepared: () => {} },
          onTransaction: (issued) => {
            transaction = issued;
          },
        });
        expect(result.status).toBe("failed");
        expect(refused).toBe(true);
        expect(openPackageActivationJournal(anchor).read().phase).toBe("publishing");
        if (!transaction) {
          throw new Error("Failed publication did not retain its package transaction.");
        }
        await expect(transaction.rollback(fence.assertCurrent)).resolves.toMatchObject({
          exitCode: 0,
        });
        expect(openPackageActivationJournal(anchor).read().phase).toBe("aborted");
        await transaction.complete({ activationVerified: true }, fence.assertCurrent);
        expect(fs.existsSync(anchor)).toBe(false);
        expect(fs.readFileSync(path.join(f.packageRoot, "package.json"), "utf8")).toContain(
          '"version":"1.0.0"',
        );
      });
    }),
);

it.skipIf(process.platform === "win32").each(["directory", "parent"] as const)(
  "preserves replacement %s contents when recovery snapshot transport fails",
  (replacement) =>
    fixtures.lifetime.run(async () => {
      const f = await fixtures.prepare();
      const journalPath = resolvePackageActivationJournalPath(f.anchor);
      const before = fs.readFileSync(journalPath);
      const open = nodeSqlite.openNodeSqliteDatabase;
      let hot = false;
      vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((file, ...args) => {
        if (!hot && file.includes("operation.sqlite")) {
          hot = true;
          throw Object.assign(new Error("read-only hot journal"), { errcode: 776 });
        }
        return open(file, ...args);
      });
      let successor = "";
      const retained = path.join(root, "retained-snapshot-owner");
      const interrupted = new Error("snapshot transport interrupted");
      const copy = vi
        .spyOn(snapshot, "createVerifiedSqliteSnapshot")
        .mockImplementation(async ({ targetPath }) => {
          const directory = path.dirname(targetPath);
          await Promise.resolve();
          const replaced =
            replacement === "directory" ? directory : resolvePackageActivationControl(f.anchor);
          fs.renameSync(replaced, retained);
          fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
          successor = path.join(directory, "successor.txt");
          fs.writeFileSync(successor, "foreign snapshot owner");
          throw interrupted;
        });
      await expect(openPackageActivationJournal(f.anchor).readForRecovery()).rejects.toMatchObject({
        cause: interrupted,
      });
      expect(hot).toBe(true);
      expect(copy).toHaveBeenCalledOnce();
      expect(fs.readFileSync(successor, "utf8")).toBe("foreign snapshot owner");
      expect(
        fs.readFileSync(
          replacement === "parent" ? path.join(retained, "operation.sqlite") : journalPath,
        ),
      ).toEqual(before);
      expect(fs.existsSync(retained)).toBe(true);
    }),
);
