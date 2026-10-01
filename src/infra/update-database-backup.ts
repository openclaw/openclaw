import fs from "node:fs/promises";
import path from "node:path";
import { sameFileIdentity } from "@openclaw/fs-safe/advanced";
import { z } from "zod";
import type { DoctorRehearsalDatabaseCoverage } from "../commands/doctor-rehearsal-databases.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openClawStateDatabaseCache } from "../state/openclaw-state-db-cache.js";
import {
  getOpenClawDatabaseMaintenanceScope,
  maintenanceOwnerHasSourceCustody,
  maintenanceOwnerMayCopySourcesInProcess,
} from "../state/openclaw-state-maintenance-context.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import {
  ensureDurableDirectory,
  requireDirectorySync,
  syncDirectory,
} from "./directory-durability.js";
import { formatDiskSpaceBytes, tryReadDiskSpace } from "./disk-space.js";
import { formatErrorMessageWithCode } from "./errors.js";
import { hasNodeErrorCode } from "./path-guards.js";
import { isSqliteSnapshotFile } from "./sqlite-file-header.js";
import { resolveSqliteDatabaseFilePaths } from "./sqlite-files.js";
import { createPrivateSqliteDirectory } from "./sqlite-private-directory.js";
import { retainSnapshotWork } from "./sqlite-readonly-location-cleanup.js";
import { measureUpdateStateFiles } from "./update-candidate-io.js";
import { UpdateStateDatabaseOwnerSchema } from "./update-candidate-paths.js";
import type { UpdateStateInspectionProgress } from "./update-candidate-state.diagnostics.js";
import {
  parseUpdateStateInspectionWorker,
  runUpdateStateInspectionWorker,
} from "./update-candidate-state.inspection.js";
import {
  discoverUpdateStateSchemaInspectionInProcess,
  UpdateStateSchemaInspectionPlanSchema,
} from "./update-candidate-state.js";
import {
  readUpdateStateDatabaseSizes,
  readUpdateStateDatabaseSizesInProcess,
} from "./update-candidate-state.sizes.js";
import { readUpdateDatabaseGenerations } from "./update-database-generations.js";
import type { UpdateRecoveryCaptureAcquisition } from "./update-recovery-capture-acquisition.js";

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
  databaseOwners: z
    .array(UpdateStateDatabaseOwnerSchema.and(z.object({ path: z.string() })))
    .optional(),
  warnings: z.array(z.string()),
});
export type UpdateDatabaseBackup = z.infer<typeof UpdateDatabaseBackupSchema> & {
  migration?: {
    name: string;
    backup: string;
    from: Record<string, string | null>;
    to: Record<string, string | null>;
  };
  restoreRefusal?: string;
};

type BackupInput = {
  backupRoot: string;
  stateDir: string;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  additionalPaths?: readonly string[];
  additionalFiles?: readonly string[];
  preserveSourceArtifacts?: boolean;
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

async function canonicalDatabaseInventory(
  plan: InspectionPlan,
  includeOwners: boolean,
  additionalPaths: readonly string[] = [],
  additionalFiles: readonly string[] = [],
  excludedDatabasePaths: readonly string[] = [],
) {
  const present = new Set<string>();
  const missing = new Set<string>();
  const owners = new Map<string, NonNullable<UpdateDatabaseBackup["databaseOwners"]>[number]>();
  const excluded = new Set(excludedDatabasePaths.flatMap(resolveSqliteDatabaseFilePaths));
  const isExcluded = (file: string) => excluded.has(resolvePathViaExistingAncestorSync(file));
  const selectedPaths = new Set(
    additionalPaths.filter((file) => !isExcluded(file)).map((file) => path.resolve(file)),
  );
  // Header readers close only in this backup child, outside the updater's SQLite lock lifetime.
  for (const file of additionalFiles) {
    if (isExcluded(file)) {
      continue;
    }
    const resolved = path.resolve(file);
    if (!selectedPaths.has(resolved) && (await isSqliteSnapshotFile(resolved))) {
      selectedPaths.add(resolved);
    }
  }
  const sources = [
    ...plan.files.map(([, database]) => database),
    ...[...selectedPaths].map((file) => ({ spellings: [file], owners: undefined })),
  ];
  for (const database of sources) {
    for (const spelling of database.spellings) {
      if (isExcluded(spelling)) {
        continue;
      }
      let canonical: string;
      try {
        canonical = await fs.realpath(spelling);
        present.add(canonical);
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
        canonical = resolvePathViaExistingAncestorSync(spelling);
        missing.add(canonical);
      }
      for (const owner of database.owners ?? []) {
        const entry = { path: canonical, ...owner };
        owners.set(JSON.stringify(entry), entry);
      }
    }
  }
  return {
    present: [...present].toSorted(),
    missing: [...missing].toSorted(),
    sourcePaths: [
      ...new Set(
        sources.flatMap((database) => database.spellings).filter((file) => !isExcluded(file)),
      ),
    ].toSorted(),
    databaseOwners: includeOwners
      ? [...owners]
          .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([, owner]) => owner)
      : undefined,
  };
}

/** Read-only capture; the caller separately decides whether automatic restoration is safe. */
export async function createUpdateDatabaseBackupInProcess(
  input: BackupInput & {
    stagingRoot: string;
    inspectionPlan: InspectionPlan;
    /** Exact families admitted by the owning Doctor before launching this backup child. */
    excludedDatabasePaths?: readonly string[];
    onProgress?: (progress: UpdateStateInspectionProgress) => void;
  },
): Promise<UpdateDatabaseBackup> {
  const directory = await fs.realpath(`${input.backupRoot}.databases`);
  // Older parents strip owners from discovery before calling the candidate worker.
  // Compare the same admitted dialect; absent metadata must not become an inventory change.
  const inspectionPlan = input.inspectionPlan;
  const includeOwners = inspectionPlan.files.some(([, database]) => database.owners !== undefined);
  const inventory = await canonicalDatabaseInventory(
    inspectionPlan,
    includeOwners,
    input.additionalPaths,
    input.additionalFiles,
    input.excludedDatabasePaths,
  );
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
      sourceAcquisition: {
        mode: "isolated-process",
        stagingRoot: input.stagingRoot,
        preserveSourceArtifacts: input.preserveSourceArtifacts,
      },
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
    databases.push({
      path: sourcePath,
      snapshotPath,
      userVersion: snapshot.userVersion,
      sha256: snapshot.sha256,
      sizeBytes: snapshot.sizeBytes,
    });
  }
  const current = await canonicalDatabaseInventory(
    await discoverUpdateStateSchemaInspectionInProcess(input),
    includeOwners,
    input.additionalPaths,
    input.additionalFiles,
    input.excludedDatabasePaths,
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
    databaseOwners: inventory.databaseOwners,
    warnings,
  };
}

/** Retain raw, verified database files separately from the old package fingerprint. */
export async function createUpdateDatabaseBackup({
  acquisition,
  nodeRunner = process.execPath,
  timeoutMs,
  signal: callerSignal,
  rehearsal,
  ...input
}: BackupInput & {
  acquisition?: UpdateRecoveryCaptureAcquisition;
  nodeRunner?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  rehearsal?: DoctorRehearsalDatabaseCoverage;
}): Promise<UpdateDatabaseBackup> {
  const controller = new AbortController();
  const additionalPaths = input.additionalPaths?.map((file) => path.resolve(file));
  const additionalFiles = input.additionalFiles?.map((file) => path.resolve(file));
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
      const workerInput = {
        ...input,
        additionalPaths,
        additionalFiles,
        backupRoot,
        stagingRoot: directory,
      };
      const shared = path.resolve(input.stateDir, "state", "openclaw.sqlite");
      const scope = getOpenClawDatabaseMaintenanceScope();
      const custody =
        acquisition?.mode === "maintenance-owner" &&
        maintenanceOwnerHasSourceCustody(scope, shared) &&
        !openClawStateDatabaseCache.isOpenClawStateDatabaseOpen(shared);
      const inspectionPlan =
        custody && maintenanceOwnerMayCopySourcesInProcess(scope, shared)
          ? await discoverUpdateStateSchemaInspectionInProcess({
              ...workerInput,
              stagingRoot: directory,
              preserveSourceArtifacts: true,
            })
          : parseUpdateStateInspectionWorker(
              await runUpdateStateInspectionWorker({
                ...worker,
                input: { ...workerInput, mode: "discover" },
                databases: custody
                  ? await readUpdateStateDatabaseSizesInProcess([shared], signal)
                  : await readUpdateStateDatabaseSizes([shared], worker),
              }),
              UpdateStateSchemaInspectionPlanSchema,
            );
      rehearsal?.assertCurrent();
      const excludedDatabasePaths = rehearsal?.admit(
        inspectionPlan.files.flatMap(([, database]) => database.spellings),
      );
      const capturedInput = { ...workerInput, excludedDatabasePaths };
      const files = [
        ...inspectionPlan.files.flatMap(([, database]) => database.spellings),
        ...(additionalPaths ?? []),
        ...(additionalFiles ?? []),
      ].filter((file) => !rehearsal?.excludes(file));
      rehearsal?.assertCurrent();
      const backup = parseUpdateStateInspectionWorker(
        await runUpdateStateInspectionWorker({
          ...worker,
          input: { ...capturedInput, mode: "database-backup", inspectionPlan },
          ...(custody ? { ioBudget: "deadline" as const } : {}),
          databases: custody
            ? await readUpdateStateDatabaseSizesInProcess(files, signal)
            : await readUpdateStateDatabaseSizes(files, worker),
        }),
        UpdateDatabaseBackupSchema,
      );
      rehearsal?.assertCurrent();
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
