import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { loadSqliteVecExtension } from "../../packages/memory-host-sdk/src/engine-storage.js";
import {
  parseUpdateRecoveryBackupManifest,
  type UpdateRecoveryBackupManifest,
} from "../commands/backup-verify-manifest.js";
import { resolveConfigPath } from "../config/config.js";
import { withConfigMutationLock } from "../config/mutate.js";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { ensurePrivateSnapshotRepositoryRoot } from "../snapshot/local-repository.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { pinDirectory, requireDirectorySync, sha256File } from "./directory-durability.js";
import { formatErrorMessage } from "./errors.js";
import { copyFileHandle, sameFileMutationFingerprint } from "./file-descriptor.js";
import { root as safeRoot } from "./fs-safe.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { assertSqliteIntegrity } from "./sqlite-integrity.js";
import { createPrivateSqliteTempDirectory } from "./sqlite-private-directory.js";
import { captureUpdateRecoveryBackup } from "./update-recovery-backup-create.js";
import {
  backupStore,
  canonicalEntryPath,
  digest,
  installDirectory,
  MAX_MANIFEST_BYTES,
  statOrMissing,
} from "./update-recovery-backup-files.js";
import { restorePreparedUpdateRecoveryBackup } from "./update-recovery-backup-restore.js";
import {
  MAX_UPDATE_RECOVERY_OUTCOME_BYTES,
  mergeUpdateRecoveryConfigWrites,
  updateRecoveryConfigWriteSchema,
  withUpdateRecoveryConfigValidation,
  withUpdateRecoveryConfigWrites,
  type UpdateRecoveryConfigWrite,
} from "./update-recovery-config-writes.js";
import { inspectUpdateRunDriver, type UpdateRunDriver } from "./update-run-driver.js";

const RETAINED_UPDATE_BACKUPS = 3;
const log = createSubsystemLogger("update/backup");
const refSchema = z
  .object({
    directory: z.string().min(1),
    manifestPath: z.string().min(1),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export type UpdateRecoveryBackupRef = z.infer<typeof refSchema>;
type Authority = { assertOwned: () => void };
type CreateOptions = Authority & {
  runId: string;
  installRoot: string;
  drivers?: UpdateRunDriver[];
};
const outcomeSchema = z
  .object({
    status: z.enum(["pending", "restored", "committed", "restore-failed"]),
    error: z.string().optional(),
  })
  .strict();
type Outcome = z.infer<typeof outcomeSchema>;
const recordedOutcomeSchema = outcomeSchema.extend({
  manifestSha256: refSchema.shape.manifestSha256,
  configWrites: z.array(updateRecoveryConfigWriteSchema).max(512).optional(),
});
type RecordedOutcome = z.infer<typeof recordedOutcomeSchema>;

/** Parse the exact manifest binding passed to the target Doctor. */
export function readUpdateRecoveryBackupRef(value: string): UpdateRecoveryBackupRef {
  return refSchema.parse(JSON.parse(value));
}

/** Capture all owned recovery inputs after the caller has stopped writers. */
export async function createUpdateRecoveryBackup(
  params: CreateOptions,
): Promise<UpdateRecoveryBackupRef> {
  return await withConfigMutationLock({}, async () => {
    const ref = await captureUpdateRecoveryBackup(params);
    await verifyUpdateRecoveryBackup(ref);
    await writeUpdateRecoveryBackupOutcome(ref, { status: "pending" }, params);
    try {
      await pruneUpdateRecoveryBackups({
        installRoot: params.installRoot,
        assertOwned: params.assertOwned,
      });
    } catch (error) {
      params.assertOwned();
      log.warn(
        `Update backup verified; older recovery sets could not be pruned: ${formatErrorMessage(error)}`,
      );
    }
    return ref;
  });
}

/** Verify every recorded payload before any restore changes live state. */
export async function verifyUpdateRecoveryBackup(
  ref: UpdateRecoveryBackupRef,
): Promise<UpdateRecoveryBackupManifest> {
  const prepared = await prepareVerifiedBackup(ref);
  try {
    return prepared.manifest;
  } finally {
    await prepared.close();
  }
}

async function prepareVerifiedBackup(ref: UpdateRecoveryBackupRef) {
  refSchema.parse(ref);
  if (
    path.resolve(ref.directory) !== ref.directory ||
    ref.manifestPath !== path.join(ref.directory, "manifest.json")
  ) {
    throw new Error("Invalid update recovery manifest locator.");
  }
  if (!(await fs.lstat(ref.directory)).isDirectory()) {
    throw new Error("Update recovery backup is not a directory.");
  }
  await ensurePrivateSnapshotRepositoryRoot(ref.directory);
  const directoryPin = await pinDirectory(ref.directory);
  let staging: string | undefined;
  const close = async () => {
    try {
      await directoryPin.assertCurrent();
      if (staging) {
        await fs.rm(staging, { recursive: true });
      }
    } finally {
      await directoryPin.close();
    }
  };
  try {
    const sourceRoot = await safeRoot(ref.directory);
    const raw = (
      await sourceRoot.read("manifest.json", {
        maxBytes: MAX_MANIFEST_BYTES,
        symlinks: "reject",
        hardlinks: "reject",
      })
    ).buffer.toString("utf8");
    if (digest(raw) !== ref.manifestSha256) {
      throw new Error("Update recovery manifest hash mismatch.");
    }
    const manifest = parseUpdateRecoveryBackupManifest(raw);
    const expectedDirectory = path.join(
      installDirectory(manifest.installRoot, manifest.stateDir),
      manifest.runId,
      "backup",
    );
    if (
      ref.directory !== expectedDirectory ||
      resolvePathViaExistingAncestorSync(resolveStateDir()) !== manifest.stateDir ||
      canonicalEntryPath(resolveConfigPath()) !== manifest.configPath
    ) {
      throw new Error("Update recovery backup belongs to another state directory or update run.");
    }
    staging = await createPrivateSqliteTempDirectory(ref.directory, ".verify-");
    const payloads = new Map<string, string>();
    for (const entry of manifest.entries) {
      if (entry.kind !== "file") {
        continue;
      }
      await directoryPin.assertCurrent();
      const source = await sourceRoot.open(entry.archivePath, {
        symlinks: "reject",
        hardlinks: "reject",
      });
      const targetPath = path.join(staging, path.basename(entry.archivePath));
      const target = await fs.open(targetPath, "wx+", 0o600);
      try {
        const before = await source.handle.stat({ bigint: true });
        await copyFileHandle(source.handle, target, {
          noProgressMessage: "Update recovery staging copy made no progress.",
        });
        const actual = await sha256File(target);
        if (
          !sameFileMutationFingerprint(before, await source.handle.stat({ bigint: true })) ||
          actual.bytes !== entry.size ||
          actual.digest !== entry.sha256
        ) {
          throw new Error(`Update recovery payload hash or size mismatch: ${entry.archivePath}`);
        }
        await target.sync();
      } finally {
        await target.close();
        await source.handle.close();
      }
      if (entry.sqlite) {
        const database = openNodeSqliteDatabase(targetPath, {
          readOnly: true,
          allowExtension: true,
        });
        try {
          await loadSqliteVecExtension({ db: database });
          assertSqliteIntegrity(database, targetPath);
        } finally {
          database.close();
        }
      }
      payloads.set(entry.archivePath, targetPath);
    }
    await directoryPin.assertCurrent();
    return { manifest, payloads, close, assertCurrent: () => directoryPin.assertCurrent() };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Restore only the frozen inventory; unrelated files created later remain owned by their creators. */
export async function restoreUpdateRecoveryBackup(
  ref: UpdateRecoveryBackupRef,
  authority: Authority,
): Promise<void> {
  const prepared = await prepareVerifiedBackup(ref);
  let restored = false;
  try {
    await withUpdateRecoveryConfigWrites(ref, authority, () =>
      withUpdateRecoveryConfigValidation(
        ref,
        prepared.manifest,
        authority,
        async (assertConfigCurrent) => {
          await restorePreparedUpdateRecoveryBackup(
            {
              ...prepared,
              assertCurrent: async () => {
                await prepared.assertCurrent();
                await assertConfigCurrent();
              },
            },
            authority,
          );
          restored = true;
        },
      ),
    );
  } catch (error) {
    if (!restored) {
      throw error;
    }
    authority.assertOwned();
    log.warn(
      `State restored; config write receipts could not be completed for ${ref.manifestPath}: ${formatErrorMessage(error)}`,
    );
  } finally {
    await prepared.close().catch((error: unknown) => {
      if (!restored) {
        throw error;
      }
      authority.assertOwned();
      log.warn(
        `State restored; temporary verification files could not be removed for ${ref.manifestPath}: ${formatErrorMessage(error)}`,
      );
    });
  }
}

async function withRecoveryMetadata<T>(
  ref: UpdateRecoveryBackupRef,
  authority: Authority,
  run: (state: {
    manifest: UpdateRecoveryBackupManifest;
    outcome?: RecordedOutcome;
    source: Awaited<ReturnType<typeof safeRoot>>;
    pin: Awaited<ReturnType<typeof pinDirectory>>;
  }) => Promise<T>,
): Promise<T> {
  authority.assertOwned();
  refSchema.parse(ref);
  if (
    path.resolve(ref.directory) !== ref.directory ||
    ref.manifestPath !== path.join(ref.directory, "manifest.json")
  ) {
    throw new Error("Invalid update recovery manifest locator.");
  }
  await ensurePrivateSnapshotRepositoryRoot(ref.directory);
  const pin = await pinDirectory(ref.directory);
  try {
    const source = await safeRoot(ref.directory);
    const bytes = await source.read("manifest.json", {
      maxBytes: MAX_MANIFEST_BYTES,
      symlinks: "reject",
      hardlinks: "reject",
    });
    if (digest(bytes.buffer) !== ref.manifestSha256) {
      throw new Error("Update recovery manifest changed before metadata access.");
    }
    const manifest = parseUpdateRecoveryBackupManifest(bytes.buffer.toString("utf8"));
    if (
      manifest.stateDir !== resolvePathViaExistingAncestorSync(resolveStateDir()) ||
      manifest.configPath !== canonicalEntryPath(resolveConfigPath()) ||
      ref.directory !==
        path.join(
          installDirectory(manifest.installRoot, manifest.stateDir),
          manifest.runId,
          "backup",
        )
    ) {
      throw new Error("Update recovery metadata belongs to another installation.");
    }
    let outcome: RecordedOutcome | undefined;
    if (await statOrMissing(path.join(ref.directory, "outcome.json"))) {
      outcome = recordedOutcomeSchema.parse(
        JSON.parse(
          (
            await source.read("outcome.json", {
              maxBytes: MAX_UPDATE_RECOVERY_OUTCOME_BYTES,
              symlinks: "reject",
              hardlinks: "reject",
            })
          ).buffer.toString("utf8"),
        ),
      );
      if (outcome.manifestSha256 !== ref.manifestSha256) {
        throw new Error("Update recovery outcome refers to another manifest.");
      }
    }
    await pin.assertCurrent();
    authority.assertOwned();
    return await run({ manifest, outcome, source, pin });
  } finally {
    await pin.close();
  }
}

async function updateRecoveryOutcome(
  ref: UpdateRecoveryBackupRef,
  authority: Authority,
  update: (
    previous: RecordedOutcome | undefined,
    manifest: UpdateRecoveryBackupManifest,
  ) => RecordedOutcome,
): Promise<void> {
  await withConfigMutationLock({ lockPath: resolveConfigPath() }, () =>
    withRecoveryMetadata(ref, authority, async ({ manifest, outcome, pin }) => {
      const next = recordedOutcomeSchema.parse(update(outcome, manifest));
      const target = path.join(ref.directory, "outcome.json");
      const temporary = `${target}.${randomUUID()}`;
      try {
        const output = await fs.open(temporary, "wx", 0o600);
        try {
          await output.writeFile(`${JSON.stringify(next)}\n`);
          await output.sync();
        } finally {
          await output.close();
        }
        await pin.assertCurrent();
        authority.assertOwned();
        await fs.rename(temporary, target);
        requireDirectorySync(await pin.sync(), "Update recovery outcome");
      } finally {
        await pin.assertCurrent();
        await fs.rm(temporary, { force: true });
      }
    }),
  );
}

export async function writeUpdateRecoveryBackupOutcome(
  ref: UpdateRecoveryBackupRef,
  outcome: Outcome,
  authority: Authority,
): Promise<void> {
  const validated = outcomeSchema.parse(outcome);
  await updateRecoveryOutcome(ref, authority, (previous) => ({
    ...validated,
    error: validated.error?.slice(0, 4_096),
    manifestSha256: ref.manifestSha256,
    configWrites: previous?.configWrites ?? [],
  }));
}

export async function appendUpdateRecoveryConfigWrites(
  ref: UpdateRecoveryBackupRef,
  writes: readonly UpdateRecoveryConfigWrite[],
  authority: Authority,
): Promise<void> {
  await updateRecoveryOutcome(ref, authority, (previous, manifest) => {
    if (!previous) {
      throw new Error("Update recovery outcome is missing; config ownership cannot be recorded.");
    }
    const unexpected = writes.find((entry) => !manifest.configPaths.includes(entry.path));
    if (unexpected) {
      throw new Error(
        `Config write ${unexpected.path} is outside the update backup inventory. Backup retained at ${ref.manifestPath}; run npx openclaw@latest doctor --fix after resolving ownership.`,
      );
    }
    return {
      ...previous,
      configWrites: mergeUpdateRecoveryConfigWrites(previous.configWrites ?? [], writes),
    };
  });
}

export async function readUpdateRecoveryConfigState(
  ref: UpdateRecoveryBackupRef,
  authority: Authority,
): Promise<{ manifest: UpdateRecoveryBackupManifest; configWrites: UpdateRecoveryConfigWrite[] }> {
  return await withRecoveryMetadata(ref, authority, async ({ manifest, outcome }) => {
    if (!outcome) {
      throw new Error("Update recovery outcome is missing; config ownership cannot be verified.");
    }
    return { manifest, configWrites: outcome.configWrites ?? [] };
  });
}

async function listBackups(
  installRoot?: string,
): Promise<
  Array<{ ref: UpdateRecoveryBackupRef; manifest: UpdateRecoveryBackupManifest; outcome: Outcome }>
> {
  const result: Array<{
    ref: UpdateRecoveryBackupRef;
    manifest: UpdateRecoveryBackupManifest;
    outcome: Outcome;
  }> = [];
  const store = backupStore();
  const base = await statOrMissing(store);
  if (!base) {
    return result;
  }
  const installs = installRoot
    ? [path.basename(installDirectory(installRoot))]
    : await fs.readdir(store);
  for (const install of installs) {
    if (!/^[a-f0-9]{32}$/u.test(install)) {
      continue;
    }
    const root = path.join(store, install);
    if (!(await statOrMissing(root))?.isDirectory()) {
      continue;
    }
    for (const run of await fs.readdir(root)) {
      const directory = path.join(root, run, "backup");
      const manifestPath = path.join(directory, "manifest.json");
      if (
        !(await statOrMissing(manifestPath))?.isFile() ||
        !(await statOrMissing(path.join(directory, "outcome.json")))?.isFile()
      ) {
        continue;
      }
      const sourceRoot = await safeRoot(directory);
      const raw = (
        await sourceRoot.read("manifest.json", {
          maxBytes: MAX_MANIFEST_BYTES,
          symlinks: "reject",
          hardlinks: "reject",
        })
      ).buffer.toString("utf8");
      const manifest = parseUpdateRecoveryBackupManifest(raw);
      const outcome = recordedOutcomeSchema.parse(
        JSON.parse(
          (
            await sourceRoot.read("outcome.json", {
              maxBytes: MAX_UPDATE_RECOVERY_OUTCOME_BYTES,
              symlinks: "reject",
              hardlinks: "reject",
            })
          ).buffer.toString("utf8"),
        ),
      );
      const ref = { directory, manifestPath, manifestSha256: outcome.manifestSha256 };
      result.push({ ref, manifest, outcome });
    }
  }
  return result.toSorted((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt));
}

export async function findPendingUpdateRecoveryBackup(
  params: { installRoot?: string } = {},
): Promise<UpdateRecoveryBackupRef | null> {
  const pending = (await listBackups(params.installRoot)).find(
    ({ outcome }) => outcome.status === "pending" || outcome.status === "restore-failed",
  );
  if (!pending) {
    return null;
  }
  await verifyUpdateRecoveryBackup(pending.ref);
  return pending.ref;
}

async function pruneUpdateRecoveryBackups(
  params: Authority & { installRoot: string },
): Promise<void> {
  const snapshots = await listBackups(params.installRoot);
  for (const snapshot of snapshots.slice(RETAINED_UPDATE_BACKUPS)) {
    const terminal =
      snapshot.outcome.status === "committed" || snapshot.outcome.status === "restored";
    if (
      !terminal &&
      [snapshot.manifest.creator, ...snapshot.manifest.drivers].some(
        (driver) => inspectUpdateRunDriver(driver) !== "dead",
      )
    ) {
      continue;
    }
    await verifyUpdateRecoveryBackup(snapshot.ref);
    params.assertOwned();
    await fs.rm(snapshot.ref.directory, { recursive: true });
  }
}
