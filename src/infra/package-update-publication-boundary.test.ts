import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
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
import { packageActivationRuntimeForTest } from "./package-update-activation-runtime.test-support.js";
import {
  assertNoPendingPackageActivation,
  runPackageActivationRecovery,
} from "./package-update-activation.js";
import * as packageFilesystem from "./package-update-filesystem.js";
import { interceptPackageFileHashes } from "./package-update-integrity-hasher.test-support.js";
import { createPublicationOwner } from "./package-update-publication-owner.js";
import * as publicationCopy from "./package-update-publication-tree.js";
import {
  createPublicationTestFixture,
  readPublicationText as read,
  readPublicationManifest as manifest,
} from "./package-update-publication.test-support.js";
import { createNpmTarget, writePackageRoot } from "./package-update-steps.test-support.js";
import type { PackageUpdateTransaction } from "./package-update-swap-contract.js";
import { swapStagedPackageInstall } from "./package-update-swap.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";
import * as snapshot from "./sqlite-snapshot.js";
import { resolveUpdateInstallRoot } from "./update-install-root.js";
import { withRetainedUpdateRuntime } from "./update-retained-runtime.js";

const fixtures = createPublicationTestFixture();
type SwapFixture = Awaited<ReturnType<typeof createPackageSwapFixture>>;
type SwapOptions = Parameters<typeof swapStagedPackageInstall>[0];
const activation = (fence: NonNullable<SwapOptions["activation"]>["fence"]) => ({
  fence,
  runtime: packageActivationRuntimeForTest(),
  onPrepared: () => {},
});
async function swap(f: SwapFixture, options: Partial<SwapOptions>) {
  let transaction: PackageUpdateTransaction | undefined;
  const result = await swapStagedPackageInstall({
    ...f.params,
    ...options,
    onTransaction: (issued) => {
      transaction = issued;
    },
  });
  return { result, transaction };
}
async function restage(f: SwapFixture, version: string) {
  await writePackageRoot(f.params.stage.packageRoot, version);
  await fixtures.writePostCoreCapability(f.params.stage.packageRoot);
  fs.mkdirSync(f.params.stage.layout.binDir, { recursive: true });
  fs.writeFileSync(path.join(f.params.stage.layout.binDir, "openclaw"), "candidate launcher\n");
}

const withFixture = fixtures.withFixture;

it.skipIf(process.platform === "win32")(
  "accepts present and temporarily missing npm roots through a canonical directory alias",
  withFixture(async (f) => {
    const aliasPrefix = path.join(fixtures.root, "live-alias");
    fs.symlinkSync(path.join(fixtures.root, "live"), aliasPrefix, "dir");
    const aliasGlobalRoot = path.join(aliasPrefix, "lib", "node_modules");
    const aliasPackageRoot = path.join(aliasGlobalRoot, "openclaw");
    const absentAliasPackageRoot = path.join(aliasGlobalRoot, "absent-openclaw");
    expect(resolveUpdateInstallRoot(absentAliasPackageRoot)).toBe(
      path.join(fs.realpathSync.native(aliasGlobalRoot), "absent-openclaw"),
    );
    const danglingAliasPackageRoot = path.join(aliasGlobalRoot, "dangling-openclaw");
    fs.symlinkSync(path.join(fixtures.root, "missing-target"), danglingAliasPackageRoot, "dir");
    expect(resolveUpdateInstallRoot(danglingAliasPackageRoot)).toBe(
      path.resolve(danglingAliasPackageRoot),
    );
    const installTarget = createNpmTarget(aliasGlobalRoot);
    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(aliasPackageRoot);
      const { result, transaction } = await swap(f, {
        installTarget,
        activation: activation(fence),
      });
      expect(result.status, result.step.stderrTail ?? undefined).toBe("committed");
      expect(transaction).toBeDefined();
      await transaction!.complete({ activationVerified: true }, fence.assertCurrent);
      expect(manifest(f.packageRoot)).toEqual({ name: "openclaw", version: "2.0.0" });
    });
  }),
);

it.skipIf(process.platform === "win32").each(["owned", "replacement"] as const)(
  "completes real launcher publication and binds retirement to its %s directory",
  withFixture(async (f, retirement) => {
    fs.writeFileSync(path.join(f.packageRoot, "previous.payload"), "previous bytes");
    fs.writeFileSync(path.join(f.params.stage.packageRoot, "candidate.payload"), "candidate bytes");
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
      const { result, transaction } = await swap(f, {
        activation: activation(fence),
      });
      expect(result.status, result.step.stderrTail ?? undefined).toBe("committed");
      expect(read(f.launcher)).toBe("candidate launcher\n");
      expect(manifest(f.packageRoot).version).toBe("2.0.0");
      const anchor = resolvePackageActivationAnchor(f.packageRoot);
      const record = openPackageActivationJournal(anchor).read();
      expect(record.phase).toBe("publication-complete");
      expect(record.publications).toEqual([
        { name: "openclaw", identity: packageActivationIdentity(f.launcher, "launcher") },
      ]);
      expect(transaction).toBeDefined();
      expect(reads).toEqual({ previous: 2, candidate: 1 });
      if (retirement === "replacement") {
        const obsolete = path.join(anchor, "previous");
        const retained = path.join(fixtures.root, "retained-previous");
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
        ).resolves.toMatchObject({
          name: "package-backup-retention",
          advisory: { kind: "recoverable-maintenance" },
        });
        const evidence = `${anchor}.superseded-${record.descriptor.operationId}`;
        expect(read(evidence, "previous/successor.txt")).toBe("foreign retirement owner");
        expect(manifest(retained).version).toBe("1.0.0");
        expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
      } else {
        // Once the candidate is verified, obsolete backup bytes are not rollback input.
        fs.writeFileSync(path.join(anchor, "previous", "previous.payload"), "obsolete bytes");
        await transaction!.complete({ activationVerified: true }, fence.assertCurrent);
        expect(reads).toEqual({ previous: 2, candidate: 1 });
        expect(fs.existsSync(anchor)).toBe(false);
        // A completed transaction stays cached even after its one-slot receipt
        // is reused by another publication under the same executor.
        await restage(f, "3.0.0");
        let nextTransaction: PackageUpdateTransaction | undefined;
        const next = await swapStagedPackageInstall({
          ...f.params,
          activation: activation(fence),
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
        expect(manifest(f.packageRoot).version).toBe("3.0.0");
      }
      expect(read(f.launcher)).toBe("candidate launcher\n");
    });
  }),
);

it.skipIf(process.platform === "win32").each(["activation", "publication", "retirement"] as const)(
  "detects same-window candidate drift only when recovery reopens %s",
  withFixture(async (f, boundary) => {
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
      const { result, transaction } = await swap(f, {
        activation: activation(fence),
        beforeActivate: async () => {
          if (boundary === "activation") {
            change(path.join(anchor, "candidate"));
          }
        },
      });
      expect(result.status, result.step.stderrTail ?? undefined).toBe("committed");
      expect(transaction).toBeDefined();
      if (boundary === "retirement") {
        change(f.packageRoot);
      }
      expect(changedBytesRead).toBe(false);
    });
    const record = openPackageActivationJournal(anchor).read();
    await expect(
      runPackageActivationRecovery(anchor, "retire", record.descriptor.operationId),
    ).rejects.toThrow("Package publication object changed");
    expect(changedBytesRead).toBe(true);
    expect(read(f.launcher)).toBe("candidate launcher\n");
    expect(read(anchor, "previous", "package.json")).toContain('"version":"1.0.0"');
    expect(read(f.packageRoot, name)).toBe("modified bytes");
    expect(await fsp.lstat(path.join(f.packageRoot, name), { bigint: true })).toEqual(unchanged);
  }),
);

it.skipIf(process.platform === "win32")(
  "admits a second publication after the live sibling refusal is resolved",
  withFixture(async (f) => {
    const refusal = new Error("A live sibling still uses this installation");
    const onTransaction = vi.fn();
    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(f.packageRoot);
      await expect(
        swapStagedPackageInstall({
          ...f.params,
          activation: activation(fence),
          beforeActivate: async () => {
            throw refusal;
          },
          onTransaction,
        }),
      ).rejects.toMatchObject({ cause: refusal });
    });
    expect(onTransaction).not.toHaveBeenCalled();
    expect(read(f.launcher)).toBe("old launcher\n");
    expect(read(f.packageRoot, "package.json")).toContain('"version":"1.0.0"');

    // The next invocation has a new executor and must pass the real admission
    // check before preparing another candidate in the same installation.
    assertNoPendingPackageActivation(f.packageRoot);
    await restage(f, "2.0.0");
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
            activation: activation(fence),
            beforeActivate: async () => {},
          });
          expect(result.status, result.step.stderrTail ?? undefined).toBe("committed");
        });
      },
    );
    assertNoPendingPackageActivation(f.packageRoot);
    expect(read(f.launcher)).toBe("candidate launcher\n");
    expect(read(f.packageRoot, "package.json")).toContain('"version":"2.0.0"');
  }),
);

it.skipIf(process.platform === "win32")(
  "retains prepared recovery when the refused callback has unjoined work",
  withFixture(async (f) => {
    const uncertainty = new CommandProcessCleanupError();
    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(f.packageRoot);
      await expect(
        swapStagedPackageInstall({
          ...f.params,
          activation: activation(fence),
          beforeActivate: async () => {
            throw uncertainty;
          },
        }),
      ).rejects.toSatisfy(hasCommandProcessCleanupError);
      const anchor = resolvePackageActivationAnchor(f.packageRoot);
      expect(openPackageActivationJournal(anchor).read().phase).toBe("prepared");
      expect(read(anchor, "candidate", "package.json")).toContain('"version":"2.0.0"');
      expect(() => assertNoPendingPackageActivation(f.packageRoot)).toThrow(
        "Package publication is incomplete",
      );
    });
  }),
);

it.skipIf(process.platform === "win32")(
  "preserves a foreign replacement and both errors when refusal retirement loses its preimage",
  withFixture(async (f) => {
    const refusal = new Error("A live sibling still uses this installation");
    const previous = path.join(fixtures.root, "previous-installation");
    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(f.packageRoot);
      await expect(
        swapStagedPackageInstall({
          ...f.params,
          activation: activation(fence),
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
      expect(read(f.packageRoot, "package.json")).toContain('"version":"3.0.0"');
      expect(read(previous, "package.json")).toContain('"version":"1.0.0"');
      expect(read(f.launcher)).toBe("old launcher\n");
      expect(
        openPackageActivationJournal(resolvePackageActivationAnchor(f.packageRoot)).read().phase,
      ).toBe("prepared");
    });
  }),
);

it
  .skipIf(process.platform === "win32")
  .each([
    "commit",
    "rollback",
    "mismatch",
    "creation-acknowledgement",
    "copy-acknowledgement",
    "partial-removal",
    "resume",
  ] as const)(
  "settles an EXDEV package displacement: %s",
  withFixture(async (f, outcome) => {
    fs.writeFileSync(path.join(f.packageRoot, "previous.payload"), "previous bytes");
    fs.symlinkSync("previous.payload", path.join(f.packageRoot, "payload.link"));
    const originalIdentity = packageActivationIdentity(f.packageRoot, true);
    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(f.packageRoot);
      const anchor = resolvePackageActivationAnchor(f.packageRoot);
      const rename = fsp.rename.bind(fsp);
      const mkdir = fsp.mkdir.bind(fsp);
      vi.spyOn(fsp, "mkdir").mockImplementation(async (...args) => {
        const result = await mkdir(...args);
        if (
          outcome === "creation-acknowledgement" &&
          (String(args[0]) === path.join(anchor, "previous.copy") ||
            String(args[0]).startsWith(`${anchor}.copy-`))
        ) {
          throw new Error("copy staging creation acknowledgement lost");
        }
        return result;
      });
      let attempts = 0;
      vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
        if (from === f.packageRoot && to === path.join(anchor, "previous")) {
          attempts++;
          throw Object.assign(new Error("EXDEV: cross-device link not permitted"), {
            code: "EXDEV",
          });
        }
        await rename(from, to);
        if (outcome === "copy-acknowledgement" && String(from).startsWith(`${anchor}.copy-`)) {
          throw new Error("copy publication acknowledgement lost");
        }
      });
      const copy = publicationCopy.copyPackagePublicationTree;
      vi.spyOn(publicationCopy, "copyPackagePublicationTree").mockImplementation(
        async (...args) => {
          await copy(...args);
          if (outcome === "mismatch") {
            fs.writeFileSync(path.join(args[1], "previous.payload"), "corrupted copy");
          }
        },
      );
      const remove = packageFilesystem.removePackagePath;
      let interrupted = false;
      vi.spyOn(packageFilesystem, "removePackagePath").mockImplementation(async (...args) => {
        if (
          (outcome === "partial-removal" || outcome === "resume") &&
          args[0] === f.packageRoot &&
          !interrupted
        ) {
          interrupted = true;
          fs.unlinkSync(path.join(f.packageRoot, "previous.payload"));
          throw new Error("source removal interrupted");
        }
        return remove(...args);
      });
      const { result, transaction } = await swap(f, {
        activation: activation(fence),
      });
      expect(attempts).toBe(1);
      const succeeded = outcome === "commit" || outcome === "rollback";
      expect(result.status, result.step.stderrTail ?? undefined).toBe(
        succeeded ? "committed" : "failed",
      );
      if (outcome === "mismatch" || outcome === "creation-acknowledgement") {
        expect(result.step.stderrTail).toContain(
          outcome === "mismatch"
            ? "Package copy inventory does not match"
            : "copy staging creation acknowledgement lost",
        );
        expect(packageActivationIdentity(f.packageRoot, true)).toBe(originalIdentity);
        expect(read(f.packageRoot, "previous.payload")).toBe("previous bytes");
        expect(read(f.launcher)).toBe("old launcher\n");
        expect(fs.existsSync(path.join(anchor, "previous"))).toBe(false);
      } else {
        const record = openPackageActivationJournal(anchor).read();
        expect(record.descriptor.previous.identity).not.toBe(originalIdentity);
        expect(record.descriptor.previous.identity).toBe(
          packageActivationIdentity(path.join(anchor, "previous"), true),
        );
        expect(read(anchor, "previous", "previous.payload")).toBe("previous bytes");
        expect(fs.readlinkSync(path.join(anchor, "previous", "payload.link"))).toBe(
          "previous.payload",
        );
      }
      if (outcome === "resume") {
        // Reopen durable facts, without the original owner's in-memory inventory.
        const owner = createPublicationOwner(
          anchor,
          openPackageActivationJournal(anchor),
          fence.assertCurrent,
        );
        await expect(owner.publish(true)).resolves.toMatchObject({ phase: "publication-complete" });
        await owner.retire();
      } else {
        if (!transaction) {
          throw new Error("Publication did not retain its package transaction.");
        }
        if (outcome !== "commit") {
          await expect(transaction.rollback(fence.assertCurrent)).resolves.toMatchObject({
            exitCode: 0,
          });
          expect(read(f.packageRoot, "previous.payload")).toBe("previous bytes");
          expect(fs.readlinkSync(path.join(f.packageRoot, "payload.link"))).toBe(
            "previous.payload",
          );
          expect(read(f.launcher)).toBe("old launcher\n");
        }
        await transaction.complete({ activationVerified: true }, fence.assertCurrent);
      }
      expect(fs.existsSync(anchor)).toBe(false);
      expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
      if (outcome === "commit" || outcome === "resume") {
        expect(read(f.launcher)).toBe("candidate launcher\n");
        expect(read(f.packageRoot, "package.json")).toContain('"version":"2.0.0"');
      }
    });
  }),
);

it.skipIf(process.platform === "win32")(
  "retires an untouched publication after its first package rename is refused",
  withFixture(async (f) => {
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
      const { result, transaction } = await swap(f, {
        activation: activation(fence),
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
      expect(read(f.packageRoot, "package.json")).toContain('"version":"1.0.0"');
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
      const retained = path.join(fixtures.root, "retained-snapshot-owner");
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
      expect(read(successor)).toBe("foreign snapshot owner");
      expect(
        fs.readFileSync(
          replacement === "parent" ? path.join(retained, "operation.sqlite") : journalPath,
        ),
      ).toEqual(before);
      expect(fs.existsSync(retained)).toBe(true);
    }),
);
