// Snapshots every SQLite database owned by the frozen backup resource inventory.
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { sameFileIdentity } from "@openclaw/fs-safe/advanced";
import { isPathInside } from "@openclaw/fs-safe/path";
import { walkDirectory } from "@openclaw/fs-safe/walk";
import {
  sealBackupResourceInventory,
  type BackupCoreDatabase,
  type BackupResourceInventory,
  type BackupResourcePlan,
} from "../commands/backup-resource-inventory.js";
import { resolveGatewayLockDir } from "../config/paths.js";
import { embedSessionColdArchivesInSnapshot } from "../config/sessions/session-cold-storage-backup.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { assertOpenClawAgentDatabaseOwner } from "../state/openclaw-agent-db-maintenance.js";
import { readOpenClawAgentDatabaseRegistryRows } from "../state/openclaw-agent-db-registry.read.js";
import { assertOpenClawStateDatabaseOwner } from "../state/openclaw-state-db-maintenance.js";
import {
  resolveOpenClawRegisteredAgentDatabasePath,
  resolveOpenClawStateSqlitePath,
  resolveQuarantineStorePath,
} from "../state/openclaw-state-db.paths.js";
import {
  sanitizeOpenClawGlobalStateSnapshot,
  sanitizeOpenClawStateLeaseRows,
} from "../state/openclaw-state-snapshot-sanitizer.js";
import {
  assertBackupSqliteSourceGroup,
  captureBackupSqliteSourceGroup,
  planBackupSqliteSourceGroups,
  type BackupSqliteSourceGroup,
} from "./backup-sqlite-source-groups.js";
import { isTransientSqliteBackupPath } from "./backup-volatile-filter.js";
import { hasErrnoCode } from "./errno.js";
import { collectErrorGraphCandidates, formatErrorMessage } from "./errors.js";
import {
  isAppleDoubleMetadataFile,
  resolveSqliteDatabaseFilePaths,
  SQLITE_SIDECAR_SUFFIXES,
} from "./sqlite-files.js";
import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";
import {
  createLegacyAuditDatabaseWitness,
  LegacyAuditBackupStateChangedError,
  rewriteLegacyAuditBackupCheckpoints,
  type LegacyAuditBackupSnapshot,
} from "./state-migrations.audit-backup.js";
import { assertNotUpdateCapturePath } from "./update-capture-paths.js";

type SqliteBackupAsset = {
  sourcePath: string;
  archiveSourcePath: string;
  skippedSourcePaths: Set<string>;
};

function findLegacyAuditBackupStateChange(
  error: unknown,
): LegacyAuditBackupStateChangedError | undefined {
  return collectErrorGraphCandidates(error, (candidate) =>
    candidate instanceof Error ? [candidate.cause] : [],
  ).find(
    (candidate): candidate is LegacyAuditBackupStateChangedError =>
      candidate instanceof LegacyAuditBackupStateChangedError,
  );
}

type CanonicalSqliteSource = {
  archiveSourcePath: string;
  identity: Stats;
  sourcePath: string;
} & ({ role: "global" | "quarantine" } | { role: "agent"; agentId: string });

function resolveSqliteBackupDatabasePath(sourcePath: string): string | undefined {
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    if (sourcePath.endsWith(suffix)) {
      const databasePath = sourcePath.slice(0, -suffix.length);
      return databasePath.endsWith(".sqlite") ? databasePath : undefined;
    }
  }
  return sourcePath.endsWith(".sqlite") ? sourcePath : undefined;
}

export function classifyBackupSqliteSource(
  sourcePath: string,
  inventory: BackupResourceInventory,
): "excluded" | "sqlite" | "opaque" | "opaque-skip" | undefined {
  const resolvedSourcePath = path.resolve(sourcePath);
  const transient = isTransientSqliteBackupPath(resolvedSourcePath);
  const databasePath = resolveSqliteBackupDatabasePath(resolvedSourcePath);
  if (!transient && !databasePath) {
    return undefined;
  }
  const withinOwnedRoot =
    isPathInside(inventory.stateDir, resolvedSourcePath) ||
    inventory.agentRoots.some(({ sourcePath: agentRoot }) =>
      isPathInside(agentRoot, resolvedSourcePath),
    );
  if (!withinOwnedRoot || inventory.isPackageContent(resolvedSourcePath)) {
    return undefined;
  }
  if (transient || !inventory.isIncluded(resolvedSourcePath)) {
    return "excluded";
  }
  if (isAppleDoubleMetadataFile(resolvedSourcePath)) {
    return "excluded";
  }
  const source = databasePath && inventory.resolveSqliteSource(databasePath);
  if (source && source.role === "unresolvable-link") {
    return resolvedSourcePath === databasePath ? "opaque-skip" : "opaque";
  }
  return source ? "sqlite" : "opaque";
}

async function discoverBackupSqliteSources(params: {
  inventory: BackupResourceInventory;
}): Promise<{ snapshotPaths: string[]; discoveredSourcePaths: Set<string> }> {
  const snapshotPaths = new Set<string>();
  const discoveredSourcePaths = new Set<string>();
  const visitedDirectories = new Set<string>();
  const gatewayLockDir = resolveGatewayLockDir(params.inventory.stateDir);

  const isRetainedPath = (pathname: string) =>
    !isPathInside(gatewayLockDir, pathname) && !params.inventory.isVolatile(pathname);
  for (const directory of [
    params.inventory.stateDir,
    ...params.inventory.agentRoots.map(({ sourcePath }) => sourcePath),
  ]) {
    const root = path.resolve(directory);
    if (visitedDirectories.has(root)) {
      continue;
    }
    visitedDirectories.add(root);
    const { entries, failedDirs } = await walkDirectory(root, {
      symlinks: "include",
      include: (entry) =>
        (entry.kind === "file" || entry.kind === "symlink") &&
        isRetainedPath(entry.path) &&
        classifyBackupSqliteSource(entry.path, params.inventory) === "sqlite",
      descend: (entry) => {
        if (
          visitedDirectories.has(entry.path) ||
          !isRetainedPath(entry.path) ||
          !params.inventory.isTraversable(entry.path) ||
          params.inventory.isPackageContent(entry.path)
        ) {
          return false;
        }
        visitedDirectories.add(entry.path);
        return true;
      },
    });
    const failure = failedDirs.find(({ error }) => !hasErrnoCode(error, "ENOENT"));
    if (failure) {
      throw failure.error;
    }
    for (const entry of entries) {
      discoveredSourcePaths.add(entry.path);
      if (entry.name.endsWith(".sqlite")) {
        snapshotPaths.add(entry.path);
      }
    }
  }

  for (const sourcePath of params.inventory.coreDatabaseSourcePaths) {
    if (params.inventory.isIncluded(sourcePath)) {
      snapshotPaths.add(sourcePath);
      discoveredSourcePaths.add(sourcePath);
    }
  }

  return {
    snapshotPaths: [...snapshotPaths].toSorted((left, right) => left.localeCompare(right)),
    discoveredSourcePaths,
  };
}

async function planBackupSqliteSources(
  inventory: BackupResourceInventory,
  snapshotPaths: readonly string[],
) {
  const sources: Array<{
    archiveSourcePath: string;
    path: string;
    identity: Stats;
    canonicalSource: CanonicalSqliteSource | undefined;
  }> = [];
  for (const archiveSourcePath of snapshotPaths) {
    const identity = await fs.stat(archiveSourcePath);
    const owner = inventory.resolveSqliteSource(archiveSourcePath, identity);
    if (!owner || owner.role === "unresolvable-link") {
      throw new Error(`SQLite ownership changed after discovery: ${archiveSourcePath}`);
    }
    let canonicalSource: CanonicalSqliteSource | undefined;
    if (owner.role !== "plugin") {
      if (!owner.identity || !sameFileIdentity(owner.identity, identity)) {
        throw new Error(`Canonical SQLite path changed after discovery: ${archiveSourcePath}`);
      }
      canonicalSource = {
        ...owner,
        archiveSourcePath: owner.sourcePath,
        sourcePath: await fs.realpath(owner.sourcePath),
        identity: owner.identity,
      };
      assertNotUpdateCapturePath(canonicalSource.sourcePath, inventory.stateDir);
    }
    sources.push({
      archiveSourcePath,
      path: canonicalSource ? await fs.realpath(archiveSourcePath) : archiveSourcePath,
      identity,
      canonicalSource,
    });
  }
  return { sources, groups: await planBackupSqliteSourceGroups(sources) };
}

export async function createBackupSqliteSnapshotPlan(params: {
  resources: BackupResourcePlan;
  tempDir: string;
  legacyAuditSnapshots: readonly LegacyAuditBackupSnapshot[];
  legacyAuditDatabaseWitness?: string;
}): Promise<{
  inventory: BackupResourceInventory;
  snapshots: SqliteBackupAsset[];
  discoveredSourcePaths: Set<string>;
}> {
  const capturedSnapshots = new Map<BackupSqliteSourceGroup, string>();
  const snapshots: SqliteBackupAsset[] = [];
  let capturedAgents: Array<{ role: "agent"; agentId: string; sourcePath: string }> = [];
  async function captureSource(
    archiveSourcePath: string,
    sourceGroup: BackupSqliteSourceGroup | undefined,
    canonicalSource?: CanonicalSqliteSource,
  ): Promise<void> {
    if (!sourceGroup) {
      throw new Error(`SQLite ownership changed after discovery: ${archiveSourcePath}`);
    }
    if (
      canonicalSource &&
      !sameFileIdentity(canonicalSource.identity, await fs.stat(archiveSourcePath))
    ) {
      throw new Error(`Canonical SQLite path changed after discovery: ${archiveSourcePath}`);
    }
    const sourceDatabasePath = sourceGroup.sourcePath;
    assertNotUpdateCapturePath(archiveSourcePath, params.resources.stateDir);
    assertNotUpdateCapturePath(sourceDatabasePath, params.resources.stateDir);
    const sourcePath = path.join(params.tempDir, `openclaw-state-db-${snapshots.length}.sqlite`);
    try {
      const capture = () =>
        createVerifiedSqliteSnapshot({
          sourcePath: sourceDatabasePath,
          targetPath: sourcePath,
          requireNonEmptySource: Boolean(canonicalSource),
          validate:
            canonicalSource?.role === "global"
              ? (database, pathname) => assertOpenClawStateDatabaseOwner(database, { pathname })
              : canonicalSource?.role === "agent"
                ? (database, pathname) =>
                    assertOpenClawAgentDatabaseOwner(database, {
                      agentId: canonicalSource.agentId,
                      pathname,
                    })
                : undefined,
          transform: async (database) => {
            if (canonicalSource?.role === "global") {
              capturedAgents = readOpenClawAgentDatabaseRegistryRows(
                database,
                canonicalSource.archiveSourcePath,
              ).map((row) => ({
                role: "agent" as const,
                agentId: normalizeAgentId(row.agent_id),
                sourcePath: resolveOpenClawRegisteredAgentDatabasePath(
                  canonicalSource.archiveSourcePath,
                  row.path,
                ),
              }));
              if (
                params.legacyAuditDatabaseWitness !== undefined &&
                createLegacyAuditDatabaseWitness(database) !== params.legacyAuditDatabaseWitness
              ) {
                throw new LegacyAuditBackupStateChangedError(
                  "Legacy audit database rows changed during SQLite backup",
                );
              }
              sanitizeOpenClawGlobalStateSnapshot(database);
              rewriteLegacyAuditBackupCheckpoints(database, params.legacyAuditSnapshots);
            } else if (canonicalSource?.role === "agent") {
              sanitizeOpenClawStateLeaseRows(database);
            }
            await embedSessionColdArchivesInSnapshot({
              database,
              sourceStorePath: canonicalSource?.archiveSourcePath ?? sourceDatabasePath,
            });
          },
        });
      const capturedPath = capturedSnapshots.get(sourceGroup);
      // Alias staging reuses the private image but still validates its journal binding.
      await captureBackupSqliteSourceGroup(sourceGroup, () =>
        capturedPath
          ? fs.copyFile(capturedPath, sourcePath, fs.constants.COPYFILE_EXCL)
          : capture(),
      );
      capturedSnapshots.set(sourceGroup, sourcePath);
    } catch (error) {
      const stateChange = findLegacyAuditBackupStateChange(error);
      if (stateChange) {
        throw stateChange;
      }
      throw new Error(
        `SQLite database cannot be compacted safely for backup: ${archiveSourcePath}. ${formatErrorMessage(error)}. The source must pass full integrity checks, online SQLite backup, and offline compaction with its required SQLite capabilities; a direct file copy was refused because it can retain deleted data.`,
        { cause: error },
      );
    }
    snapshots.push({
      sourcePath,
      archiveSourcePath,
      skippedSourcePaths: new Set(
        [archiveSourcePath, sourceDatabasePath].flatMap((databasePath) =>
          resolveSqliteDatabaseFilePaths(databasePath).map((pathname) => path.resolve(pathname)),
        ),
      ),
    });
  }

  const globalPath = resolveOpenClawStateSqlitePath({
    ...process.env,
    OPENCLAW_STATE_DIR: params.resources.stateDir,
  });
  const globalEntry = await fs.lstat(globalPath).catch((error: unknown) => {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  });
  let globalIdentity: Stats | undefined;
  let globalGroup: BackupSqliteSourceGroup | undefined;
  if (globalEntry) {
    globalIdentity = globalEntry.isSymbolicLink() ? await fs.stat(globalPath) : globalEntry;
    if (!globalIdentity.isFile()) {
      throw new Error(
        `Canonical global SQLite path must be a regular file or symlink to one: ${globalPath}`,
      );
    }
    const globalSource: CanonicalSqliteSource = {
      role: "global",
      archiveSourcePath: globalPath,
      sourcePath: await fs.realpath(globalPath),
      identity: globalIdentity,
    };
    const globalInventory = sealBackupResourceInventory(params.resources, [
      { role: "global", sourcePath: globalPath, identity: globalIdentity },
    ]);
    const { snapshotPaths } = await discoverBackupSqliteSources({ inventory: globalInventory });
    const { groups } = await planBackupSqliteSources(
      globalInventory,
      snapshotPaths.filter(
        (sourcePath) => globalInventory.resolveSqliteSource(sourcePath)?.role === "global",
      ),
    );
    globalGroup = groups.get(globalSource.sourcePath);
    await captureSource(globalPath, globalGroup, globalSource);
  } else {
    for (const sidecar of resolveSqliteDatabaseFilePaths(globalPath).slice(1)) {
      const exists = await fs.lstat(sidecar).catch((error: unknown) => {
        if (hasErrnoCode(error, "ENOENT")) {
          return undefined;
        }
        throw error;
      });
      if (exists) {
        throw new Error(
          `Canonical global SQLite database is missing but a sidecar remains: ${sidecar}`,
        );
      }
    }
  }
  const coreDatabases: BackupCoreDatabase[] = [
    { role: "global", sourcePath: globalPath, identity: globalIdentity },
  ];
  for (const database of [
    {
      role: "quarantine" as const,
      sourcePath: resolveQuarantineStorePath({
        ...process.env,
        OPENCLAW_STATE_DIR: params.resources.stateDir,
      }),
    },
    ...capturedAgents,
  ]) {
    const identity = await fs.stat(database.sourcePath).catch((error: unknown) => {
      if (hasErrnoCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    });
    if (identity && !identity.isFile()) {
      throw new Error(`Core SQLite path must resolve to a regular file: ${database.sourcePath}`);
    }
    coreDatabases.push(Object.freeze({ ...database, identity }));
  }
  const inventory = sealBackupResourceInventory(params.resources, coreDatabases);
  const discovery = await discoverBackupSqliteSources({ inventory });
  const { sources, groups } = await planBackupSqliteSources(inventory, discovery.snapshotPaths);
  for (const source of sources) {
    if (source.archiveSourcePath !== globalPath) {
      // The archived registry must remain the image that supplied capturedAgents.
      await captureSource(
        source.archiveSourcePath,
        source.canonicalSource?.role === "global" ? globalGroup : groups.get(source.path),
        source.canonicalSource,
      );
    }
  }
  if (globalGroup) {
    await assertBackupSqliteSourceGroup(globalGroup);
  }
  for (const source of coreDatabases) {
    if (source.identity && !sameFileIdentity(source.identity, await fs.stat(source.sourcePath))) {
      throw new Error(`Canonical SQLite path changed after discovery: ${source.sourcePath}`);
    }
  }
  return { inventory, snapshots, discoveredSourcePaths: discovery.discoveredSourcePaths };
}
