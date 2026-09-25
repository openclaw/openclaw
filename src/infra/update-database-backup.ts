import fs from "node:fs/promises";
import path from "node:path";
import { sameFileIdentity } from "@openclaw/fs-safe/advanced";
import { z } from "zod";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import {
  ensureDurableDirectory,
  requireDirectorySync,
  sha256File,
  syncDirectory,
} from "./directory-durability.js";
import { formatDiskSpaceBytes, tryReadDiskSpace } from "./disk-space.js";
import { formatErrorMessageWithCode } from "./errors.js";
import { hasNodeErrorCode } from "./path-guards.js";
import { createPrivateSqliteDirectory } from "./sqlite-private-directory.js";
import { retainSnapshotWork } from "./sqlite-readonly-location-cleanup.js";
import { measureUpdateStateFiles } from "./update-candidate-io.js";
import type { UpdateStateInspectionProgress } from "./update-candidate-state.diagnostics.js";
import {
  parseUpdateStateInspectionWorker,
  runUpdateStateInspectionWorker,
} from "./update-candidate-state.inspection.js";
import {
  discoverUpdateStateSchemaInspectionInProcess,
  UpdateStateSchemaInspectionPlanSchema,
} from "./update-candidate-state.js";
import { readUpdateStateDatabaseSizes } from "./update-candidate-state.sizes.js";
import { readUpdateDatabaseGenerations } from "./update-database-generations.js";

const UpdateDatabaseBackupSchema = z.object({
  directory: z.string(),
  databases: z.array(
    z.object({
      path: z.string(),
      snapshotPath: z.string(),
      userVersion: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      sizeBytes: z.number().int().nonnegative(),
    }),
  ),
  missingPaths: z.array(z.string()),
  sourcePaths: z.array(z.string()),
  sourceGenerations: z.record(z.string(), z.string().nullable()),
  warnings: z.array(z.string()),
});
export type UpdateDatabaseBackup = z.infer<typeof UpdateDatabaseBackupSchema> & {
  postMigrationGenerations?: Record<string, string | null>;
  restoreRefusal?: string;
};

type BackupInput = {
  backupRoot: string;
  stateDir: string;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
};
type InspectionPlan = z.infer<typeof UpdateStateSchemaInspectionPlanSchema>;

async function inspectRestorableDatabaseFiles(
  databases: readonly string[],
  previous?: ReadonlyMap<string, Awaited<ReturnType<typeof fs.lstat>>>,
) {
  const identities = new Map<string, Awaited<ReturnType<typeof fs.lstat>>>();
  for (const database of databases) {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const file = `${database}${suffix}`;
      let info;
      try {
        info = await fs.lstat(file);
      } catch (error) {
        if (suffix && hasNodeErrorCode(error, "ENOENT")) {
          continue;
        }
        throw error;
      }
      if (!info.isFile() || info.nlink !== 1) {
        throw new Error(
          `Update database rollback requires a regular file with one link: ${file}. Resolve database aliases before retrying; the databases have not been migrated.`,
        );
      }
      const before = previous?.get(file);
      if (before && !sameFileIdentity(before, info)) {
        throw new Error(`Update database file changed during backup: ${file}.`);
      }
      identities.set(file, info);
    }
  }
  return identities;
}

async function checkDatabaseBackupSpace(directory: string, files: readonly string[]) {
  const { bytes, largest, families } = await measureUpdateStateFiles(files);
  const warnings: string[] = [];
  const check = (target: string, requiredBytes: number, purpose: string) => {
    const space = tryReadDiskSpace(target);
    if (space && space.availableBytes < requiredBytes) {
      throw new Error(
        `${purpose} needs ${formatDiskSpaceBytes(requiredBytes)} near ${target}, but only ${formatDiskSpaceBytes(space.availableBytes)} is available. Free disk space before retrying; the databases have not been migrated.`,
      );
    }
    if (!space) {
      warnings.push(
        `Available disk space could not be measured near ${target}; database backup will be attempted.`,
      );
    }
  };
  const reserve = 64 * 1024 * 1024;
  // This volume holds snapshots, same-volume rollback copies, and acquisition/publication scratch.
  check(directory, bytes === 0 ? 0 : 2 * bytes + 3 * largest + reserve, "Update database backup");
  const backupDevice = (await fs.stat(directory, { bigint: true })).dev;
  const sources = new Map<bigint | string, { directory: string; bytes: number; largest: number }>();
  for (const family of families) {
    const sourceDirectory = path.dirname(family.path);
    const device = (await fs.stat(sourceDirectory, { bigint: true })).dev;
    if (device > 0n && device === backupDevice) {
      continue;
    }
    // Unknown identity cannot prove that the backup volume's allowance covers this destination.
    const key = device > 0n ? device : sourceDirectory;
    let source = sources.get(key);
    if (!source) {
      source = { directory: sourceDirectory, bytes: 0, largest: 0 };
      sources.set(key, source);
      if (device === 0n) {
        warnings.push(
          `Filesystem identity is unavailable near ${sourceDirectory}; restore space is checked separately.`,
        );
      }
    }
    source.bytes += family.bytes;
    source.largest = Math.max(source.largest, family.bytes);
  }
  for (const source of sources.values()) {
    // Migrated files remain in place during rollback: reserve S + largest publication scratch + headroom.
    check(source.directory, source.bytes + source.largest + reserve, "Update database rollback");
  }
  return warnings;
}

async function canonicalDatabaseInventory(plan: InspectionPlan) {
  const present = new Set<string>();
  const missing = new Set<string>();
  for (const [, database] of plan.files) {
    for (const spelling of database.spellings) {
      try {
        present.add(await fs.realpath(spelling));
      } catch (error) {
        if (!hasNodeErrorCode(error, "ENOENT")) {
          throw error;
        }
        // A dangling alias is not proof that a database was absent.
        const entry = await fs.lstat(spelling).catch((cause: unknown) => {
          if (!hasNodeErrorCode(cause, "ENOENT")) {
            throw cause;
          }
          return undefined;
        });
        if (entry) {
          throw new Error(`Update database path cannot be resolved: ${spelling}`, { cause: error });
        }
        missing.add(resolvePathViaExistingAncestorSync(spelling));
      }
    }
  }
  return {
    present: [...present].toSorted(),
    missing: [...missing].toSorted(),
    sourcePaths: [...new Set(plan.files.flatMap(([, database]) => database.spellings))].toSorted(),
  };
}

/** Read-only capture; the caller separately decides whether automatic restoration is safe. */
export async function createUpdateDatabaseBackupInProcess(
  input: BackupInput & {
    stagingRoot: string;
    inspectionPlan: InspectionPlan;
    onProgress?: (progress: UpdateStateInspectionProgress) => void;
  },
): Promise<UpdateDatabaseBackup> {
  const directory = await fs.realpath(`${input.backupRoot}.databases`);
  const inventory = await canonicalDatabaseInventory(input.inspectionPlan);
  const identities = await inspectRestorableDatabaseFiles(inventory.present);
  const warnings = await checkDatabaseBackupSpace(directory, inventory.present);
  const { buildBackupArchivePath } = await import("../commands/backup-shared.js");
  const { createVerifiedSqliteSnapshot } = await import("./sqlite-snapshot.js");
  const databases: UpdateDatabaseBackup["databases"] = [];
  const sourceGenerations: UpdateDatabaseBackup["sourceGenerations"] = Object.fromEntries(
    inventory.missing.map((file) => [file, null]),
  );
  const readGeneration = (file: string) => {
    try {
      return readUpdateDatabaseGenerations([file])[file] ?? undefined;
    } catch (error) {
      warnings.push(
        `Database write generation unavailable for ${file}: ${formatErrorMessageWithCode(error)}`,
      );
      return undefined;
    }
  };
  for (const sourcePath of inventory.present) {
    input.onProgress?.({ phase: "pre-migration database backup", path: sourcePath });
    const archivePath = buildBackupArchivePath("", sourcePath);
    let parent = directory;
    for (const component of path.posix.dirname(archivePath).split("/")) {
      parent = path.join(parent, component);
      await ensureDurableDirectory({ directoryPath: parent, create: createPrivateSqliteDirectory });
    }
    const snapshotPath = path.join(directory, archivePath);
    const before = readGeneration(sourcePath);
    const snapshot = await createVerifiedSqliteSnapshot({
      sourcePath,
      targetPath: snapshotPath,
      sourceAcquisition: { mode: "isolated-process", stagingRoot: input.stagingRoot },
      preserveRowIds: true,
      requireNonEmptySource: true,
    });
    const after = readGeneration(sourcePath);
    if (after !== undefined && before === after) {
      sourceGenerations[sourcePath] = after;
    } else {
      warnings.push(
        `Database changed during capture; its snapshot requires manual recovery: ${sourcePath}`,
      );
    }
    const { digest, bytes: sizeBytes } = await sha256File(snapshotPath);
    databases.push({
      path: sourcePath,
      snapshotPath,
      userVersion: snapshot.userVersion,
      sha256: digest,
      sizeBytes,
    });
  }
  const current = await canonicalDatabaseInventory(
    await discoverUpdateStateSchemaInspectionInProcess(input),
  );
  if (JSON.stringify(current) !== JSON.stringify(inventory)) {
    throw new Error("Update database inventory changed during backup; retry after writers stop.");
  }
  await inspectRestorableDatabaseFiles(inventory.present, identities);
  return {
    directory,
    databases,
    missingPaths: inventory.missing,
    sourcePaths: inventory.sourcePaths,
    sourceGenerations,
    warnings,
  };
}

/** Retain raw, verified database files separately from the old package fingerprint. */
export async function createUpdateDatabaseBackup({
  nodeRunner = process.execPath,
  timeoutMs,
  signal: callerSignal,
  ...input
}: BackupInput & {
  nodeRunner?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<UpdateDatabaseBackup> {
  const controller = new AbortController();
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, controller.signal])
    : controller.signal;
  const work = (async () => {
    signal.throwIfAborted();
    const backupRoot = path.resolve(input.backupRoot);
    const directory = `${backupRoot}.databases`;
    await createPrivateSqliteDirectory(directory);
    const identity = await fs.lstat(directory);
    try {
      const sourceEnv = input.env ?? process.env;
      const worker = { nodeRunner, timeoutMs, signal, sourceEnv, stagingRoot: directory };
      // Each SQLite reader owns its token-protected scratch beneath this private backup directory.
      const workerInput = { ...input, backupRoot, stagingRoot: directory };
      const shared = path.resolve(input.stateDir, "state", "openclaw.sqlite");
      const inspectionPlan = parseUpdateStateInspectionWorker(
        await runUpdateStateInspectionWorker({
          ...worker,
          input: { ...workerInput, mode: "discover" },
          databases: await readUpdateStateDatabaseSizes([shared], worker),
        }),
        UpdateStateSchemaInspectionPlanSchema,
      );
      const files = inspectionPlan.files.flatMap(([, database]) => database.spellings);
      const backup = parseUpdateStateInspectionWorker(
        await runUpdateStateInspectionWorker({
          ...worker,
          input: { ...workerInput, mode: "database-backup", inspectionPlan },
          databases: await readUpdateStateDatabaseSizes(files, worker),
        }),
        UpdateDatabaseBackupSchema,
      );
      if (!sameFileIdentity(identity, await fs.lstat(directory))) {
        throw new Error(`Database backup directory changed during capture: ${directory}.`);
      }
      requireDirectorySync(await syncDirectory(path.dirname(directory)), "Database backup parent");
      return backup;
    } catch (error) {
      // Partial artifacts stay with recovery; this parent never races the SQLite scratch owners.
      throw new Error(
        `${formatErrorMessageWithCode(error)}. Database backup files retained at ${directory}.`,
        { cause: error },
      );
    }
  })();
  return retainSnapshotWork(work, () => controller.abort());
}
