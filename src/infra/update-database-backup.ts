import type { BigIntStats } from "node:fs";
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
import { resolveDatabaseFamilyEngines } from "./database-engine/registry.js";
import {
  ensureDurableDirectory,
  requireDirectorySync,
  syncDirectory,
} from "./directory-durability.js";
import { formatDiskSpaceBytes, tryReadDiskSpace } from "./disk-space.js";
import { ignoreMissingPath } from "./errno.js";
import { formatErrorMessageWithCode } from "./errors.js";
import { sameFileMutationFingerprint } from "./file-descriptor.js";
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
import { readUpdatePhysicalDatabaseGenerations } from "./update-physical-database-generations.js";
import type { UpdateRecoveryCaptureAcquisition } from "./update-recovery-capture-acquisition.js";

export const UpdateDatabaseBackupSchema = z.object({
  directory: z.string(),
  databases: z.array(
    z.object({
      path: z.string(),
      snapshotPath: z.string(),
      userVersion: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      sizeBytes: z.number().int().nonnegative(),
      engine: z.literal("postgres").optional(),
      storeId: z.string().uuid().optional(),
      namespace: z.string().optional(),
      exportDirectory: z.string().optional(),
    }),
  ),
  pluginOwners: z
    .record(
      z.string(),
      z.object({
        id: z.string(),
        rootDir: z.string(),
        source: z.string(),
        origin: z.enum(["bundled", "global", "workspace", "config"]),
      }),
    )
    .optional(),
  missingPaths: z.array(z.string()),
  sourcePaths: z.array(z.string()),
  sourceGenerations: z.record(z.string(), z.string().nullable()),
  /** Manual original images held under maintenance custody; never automatic rollback authority. */
  originalCaptureSourcePaths: z.array(z.string()).optional(),
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
  integrityCheck?: "quick" | "full";
  /** Native migration owns the stopped Gateway until Doctor takes custody. */
  stopped?: boolean;
  postgresOffline?: boolean;
  pluginOwners?: UpdateDatabaseBackup["pluginOwners"];
};
type InspectionPlan = z.infer<typeof UpdateStateSchemaInspectionPlanSchema>;

async function loadUpdateDatabaseBackupRuntime() {
  const [{ discoverBackupDatabasePaths }, { readBackupEngine }] = await Promise.all([
    import("./backup-sqlite-snapshot.js"),
    import("../snapshot/database-backup.js"),
  ]);
  return { discoverBackupDatabasePaths, readBackupEngine };
}

let backupRuntime: ReturnType<typeof loadUpdateDatabaseBackupRuntime> | undefined;

/** Resolve the backup's lazy modules before an updater replaces its own dist tree. */
export function prepareUpdateDatabaseBackupRuntime() {
  return (backupRuntime ??= loadUpdateDatabaseBackupRuntime());
}

async function inspectRestorableDatabaseFiles(
  databases: readonly string[],
  previous?: ReadonlyMap<string, BigIntStats>,
  stopped = false,
) {
  const identities = new Map<string, BigIntStats>();
  for (const database of databases) {
    // Readers mutate/recreate the transient WAL index; only durable files fence capture.
    for (const suffix of ["", "-wal", "-journal"]) {
      const file = `${database}${suffix}`;
      let info;
      try {
        info = await fs.lstat(file, { bigint: true });
      } catch (error) {
        if (suffix && hasNodeErrorCode(error, "ENOENT")) {
          continue;
        }
        throw error;
      }
      if (!info.isFile() || info.nlink !== 1n) {
        throw new Error(
          `Update database rollback requires a regular file with one link: ${file}. Resolve database aliases before retrying; the databases have not been migrated.`,
        );
      }
      const before = previous?.get(file);
      if (
        before &&
        !(stopped ? sameFileMutationFingerprint(before, info) : sameFileIdentity(before, info))
      ) {
        throw new Error(`Update database file changed during backup: ${file}.`);
      }
      // Readers can create an empty WAL beside a checkpointed database.
      if (suffix !== "-wal" || info.size !== 0n) {
        identities.set(file, info);
      }
    }
  }
  if (stopped && previous) {
    const changed = [...previous.keys(), ...identities.keys()].find(
      (file) => previous.has(file) !== identities.has(file),
    );
    if (changed) {
      throw new Error(`Update database journal state changed during stopped backup: ${changed}.`);
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
        ignoreMissingPath(error);
        // A dangling alias is not proof that a database was absent.
        const entry = await fs.lstat(spelling).catch(ignoreMissingPath);
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
    /** Source custody prepared by the parent only for manual original-state capture. */
    originalCaptureSourcePaths?: readonly string[];
    onProgress?: (progress: UpdateStateInspectionProgress) => void;
  },
): Promise<UpdateDatabaseBackup> {
  const directory = await fs.realpath(`${input.backupRoot}.databases`);
  // Older parents strip owners from discovery before calling the candidate worker.
  // Compare the same admitted dialect; absent metadata must not become an inventory change.
  const inspectionPlan = input.inspectionPlan;
  const includeOwners = inspectionPlan.files.some(([, database]) => database.owners !== undefined);
  const inventoryFor = (plan: InspectionPlan) =>
    canonicalDatabaseInventory(
      plan,
      includeOwners,
      input.additionalPaths,
      input.additionalFiles,
      input.excludedDatabasePaths,
    );
  const inventory = await inventoryFor(inspectionPlan);
  const identities = await inspectRestorableDatabaseFiles(inventory.present);
  const warnings = await checkDatabaseBackupSpace(directory, inventory.present);
  const { buildBackupArchivePath } = await import("../commands/backup-shared.js");
  const { createStoppedSqliteSnapshot, createVerifiedSqliteSnapshot } =
    await import("./sqlite-snapshot.js");
  const { AGENT_FTS_SCHEMAS } = await import("../state/openclaw-agent-fts-schema.js");
  const databases: UpdateDatabaseBackup["databases"] = [];
  const sourceGenerations: UpdateDatabaseBackup["sourceGenerations"] = Object.fromEntries(
    inventory.missing.map((file) => [file, null]),
  );
  const readGeneration = async (file: string) => {
    try {
      return (
        (await readUpdatePhysicalDatabaseGenerations([file], input.pluginOwners))[file] ?? undefined
      );
    } catch (error) {
      warnings.push(
        `Database write generation unavailable for ${file}: ${formatErrorMessageWithCode(error)}`,
      );
      return undefined;
    }
  };
  const { readBackupEngine, capturePostgresBackup } =
    await import("../snapshot/database-backup.js");
  const engines = new Map(inventory.present.map((file) => [file, readBackupEngine(file)]));
  const originalCaptureSources = new Set(
    input.originalCaptureSourcePaths?.filter((file) => engines.get(file)?.engine === "sqlite"),
  );
  if (
    [...engines.values()].some((engine) => engine.engine === "postgres") &&
    !input.postgresOffline &&
    !input.stopped
  ) {
    throw new Error(
      "PostgreSQL update capture requires exclusive ownership; stop through the service owner, then rerun.",
    );
  }
  for (const sourcePath of inventory.present) {
    input.onProgress?.({ phase: "pre-migration database backup", path: sourcePath });
    const archivePath = buildBackupArchivePath("", sourcePath);
    let parent = directory;
    for (const component of path.posix.dirname(archivePath).split("/")) {
      parent = path.join(parent, component);
      await ensureDurableDirectory({ directoryPath: parent, create: createPrivateSqliteDirectory });
    }
    const snapshotPath = path.join(directory, archivePath);
    const stopped =
      input.stopped &&
      !identities.has(`${sourcePath}-journal`) &&
      (identities.get(`${sourcePath}-wal`)?.size ?? 0n) === 0n;
    const retainGeneration = !input.stopped && !originalCaptureSources.has(sourcePath);
    const before = retainGeneration ? await readGeneration(sourcePath) : undefined;
    const snapshot = stopped
      ? await createStoppedSqliteSnapshot({
          sourcePath,
          targetPath: snapshotPath,
          sourceIdentity: identities.get(sourcePath)!,
        })
      : await createVerifiedSqliteSnapshot({
          sourcePath,
          targetPath: snapshotPath,
          sourceAcquisition: {
            mode: "isolated-process",
            stagingRoot: input.stagingRoot,
            preserveSourceArtifacts: input.stopped || input.preserveSourceArtifacts,
          },
          preserveRowIds: true,
          requireNonEmptySource: true,
          // Owned FTS indexes are derived; whichever runtime admits this copy rebuilds them.
          integrity:
            engines.get(sourcePath)?.engine === "sqlite"
              ? { check: input.integrityCheck ?? "full", ftsSchemas: AGENT_FTS_SCHEMAS }
              : undefined,
        });
    const engine = engines.get(sourcePath)!;
    let postgres;
    if (engine.engine === "postgres") {
      const exportDirectory = `${snapshotPath}.postgres`;
      await capturePostgresBackup({
        sourcePath,
        directory: exportDirectory,
        profile: "exact",
        config: input.config,
        pluginOwners: input.pluginOwners,
        assertCurrent: () => {},
      });
      postgres = { ...engine, exportDirectory };
    }
    // Automatic rollback keeps write attribution after custody ends. Manual original
    // capture stays under its maintenance owner and never grants restore authority.
    if (retainGeneration) {
      const after = await readGeneration(sourcePath);
      if (after !== undefined && before === after) {
        sourceGenerations[sourcePath] = after;
      } else {
        warnings.push(
          `Database changed during capture; its snapshot requires manual recovery: ${sourcePath}`,
        );
      }
    }
    databases.push({
      path: sourcePath,
      snapshotPath,
      userVersion: snapshot.userVersion,
      sha256: snapshot.sha256,
      sizeBytes: snapshot.sizeBytes,
      ...postgres,
    });
  }
  const current = await inventoryFor(
    await discoverUpdateStateSchemaInspectionInProcess({
      ...input,
      preserveSourceArtifacts: input.stopped || input.preserveSourceArtifacts,
    }),
  );
  if (JSON.stringify(current) !== JSON.stringify(inventory)) {
    throw new Error("Update database inventory changed during backup; retry after writers stop.");
  }
  await inspectRestorableDatabaseFiles(inventory.present, identities, input.stopped);
  return {
    directory,
    databases,
    missingPaths: inventory.missing,
    sourcePaths: inventory.sourcePaths,
    sourceGenerations,
    ...(input.originalCaptureSourcePaths
      ? { originalCaptureSourcePaths: [...originalCaptureSources] }
      : {}),
    databaseOwners: inventory.databaseOwners,
    warnings,
    ...(input.pluginOwners ? { pluginOwners: input.pluginOwners } : {}),
  };
}

/** Retain raw, verified database files separately from the old package fingerprint. */
export async function createUpdateDatabaseBackup({
  acquisition,
  purpose,
  nodeRunner = process.execPath,
  timeoutMs,
  signal: callerSignal,
  rehearsal,
  retryAdvice,
  ...input
}: BackupInput & {
  acquisition?: UpdateRecoveryCaptureAcquisition;
  /** Original-state evidence does not need generations while its owner retains every source. */
  purpose?: "original-state";
  nodeRunner?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  rehearsal?: DoctorRehearsalDatabaseCoverage;
  retryAdvice?: boolean;
}): Promise<UpdateDatabaseBackup> {
  const controller = new AbortController();
  const { discoverBackupDatabasePaths, readBackupEngine } =
    await prepareUpdateDatabaseBackupRuntime();
  const prepared = Object.values(resolveDatabaseFamilyEngines(input.config)).includes("postgres")
    ? await (await import("./backup-database-discovery.js")).preparePostgresBackupDiscovery(input)
    : {
        // Read legacy SQLite registrations from the private inspection copy, before admission.
        paths: await discoverBackupDatabasePaths({ ...input, agentRegistry: [] }),
        pluginOwners: undefined,
      };
  const additionalPaths = [...(input.additionalPaths ?? []), ...prepared.paths].map((file) =>
    path.resolve(file),
  );
  const additionalFiles = input.additionalFiles?.map((file) => path.resolve(file));
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, controller.signal])
    : controller.signal;
  const work = (async () => {
    signal.throwIfAborted();
    const backupRoot = path.resolve(input.backupRoot);
    const directory = `${backupRoot}.databases`;
    await createPrivateSqliteDirectory(directory);
    const identity = await fs.lstat(directory, { bigint: true });
    try {
      const sourceEnv = input.env ?? process.env;
      const worker = { nodeRunner, timeoutMs, signal, sourceEnv, stagingRoot: directory };
      // Each SQLite reader owns its token-protected scratch beneath this private backup directory.
      const workerInput = {
        ...input,
        ...(prepared.pluginOwners ? { pluginOwners: prepared.pluginOwners } : {}),
        preserveSourceArtifacts: input.stopped || input.preserveSourceArtifacts,
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
      // Only maintenance admission consumes this classification. Other callers
      // let the backup worker inspect engines without another full source image.
      const postgresPaths = custody
        ? prepared.paths.filter((file) => readBackupEngine(file).engine === "postgres")
        : [];
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
                retryAdvice,
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
      const capturedInput = {
        ...workerInput,
        excludedDatabasePaths,
        postgresOffline: input.postgresOffline || custody,
      };
      const files = [
        ...inspectionPlan.files.flatMap(([, database]) => database.spellings),
        ...(additionalPaths ?? []),
        ...(additionalFiles ?? []),
      ].filter((file) => !rehearsal?.excludes(file));
      let originalCaptureSourcePaths: string[] | undefined;
      if (purpose === "original-state" && custody) {
        const { isOpenClawAgentDatabaseOpen } = await import("../state/openclaw-agent-db.js");
        originalCaptureSourcePaths = [
          ...new Set(files.map(resolvePathViaExistingAncestorSync)),
        ].filter(
          (file) =>
            maintenanceOwnerHasSourceCustody(scope, file) &&
            !openClawStateDatabaseCache.isOpenClawStateDatabaseOpen(file) &&
            !isOpenClawAgentDatabaseOpen(file),
        );
      }
      rehearsal?.assertCurrent();
      const databases = custody
        ? await readUpdateStateDatabaseSizesInProcess(files, signal)
        : await readUpdateStateDatabaseSizes(files, worker);
      if (custody && postgresPaths.length > 0) {
        scope!.assertAdmission();
      }
      const backup = parseUpdateStateInspectionWorker(
        await runUpdateStateInspectionWorker({
          ...worker,
          retryAdvice,
          input: {
            ...capturedInput,
            mode: "database-backup",
            inspectionPlan,
            originalCaptureSourcePaths,
          },
          ...(custody ? { ioBudget: "deadline" as const } : {}),
          databases,
        }),
        UpdateDatabaseBackupSchema,
      );
      if (custody && postgresPaths.length > 0) {
        scope!.assertAdmission();
      }
      rehearsal?.assertCurrent();
      if (!sameFileIdentity(identity, await fs.lstat(directory, { bigint: true }))) {
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
