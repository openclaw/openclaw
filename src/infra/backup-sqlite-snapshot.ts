// Snapshots every SQLite database owned by the frozen backup resource inventory.
import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";
import { sameFileIdentity } from "@openclaw/fs-safe/advanced";
import { isPathInside } from "@openclaw/fs-safe/path";
import { walkDirectory } from "@openclaw/fs-safe/walk";
import {
  sealBackupResourceInventory,
  createBackupResourcePlan,
  type BackupCoreDatabase,
  type BackupResourceInventory,
  type BackupResourcePlan,
} from "../commands/backup-resource-inventory.js";
import { resolveGatewayLockDir } from "../config/paths.js";
import { embedSessionColdArchivesInSnapshot } from "../config/sessions/session-cold-storage-backup.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { capturePostgresBackup, readBackupEngineImage } from "../snapshot/database-backup.js";
import { listDefaultAgentDatabasePaths } from "../state/agent-database-path-discovery.js";
import type { OpenClawRegisteredAgentDatabase } from "../state/openclaw-agent-db-contract.js";
import { assertOpenClawAgentDatabaseOwner } from "../state/openclaw-agent-db-maintenance.js";
import { readOpenClawAgentDatabaseRegistryRows } from "../state/openclaw-agent-db-registry.read.js";
import { assertOpenClawStateDatabaseOwner } from "../state/openclaw-state-db-maintenance.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
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
import type { ClientCredentialDatabase } from "./client-credential-schema.js";
import { resolveClientCredentialStorePath } from "./client-credential-store.js";
import { resolveAgentPortRoots } from "./database-engine/agent-port.js";
import { readEngineAnchor } from "./database-engine/open.js";
import { listDatabaseEngineStores, selectDatabaseEngine } from "./database-engine/registry.js";
import { sha256File } from "./directory-durability.js";
import { hasErrnoCode } from "./errno.js";
import { collectErrorGraphCandidates, formatErrorMessage } from "./errors.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
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
import { collectStateDatabasePaths } from "./update-candidate-state.js";
import { assertNotUpdateCapturePath } from "./update-capture-paths.js";

type SqliteBackupAsset = {
  sourcePath: string;
  archiveSourcePath: string;
  skippedSourcePaths: Set<string>;
};

function ignoreMissingSource(error: unknown): undefined {
  if (!hasErrnoCode(error, "ENOENT")) {
    throw error;
  }
}

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
  identity: BigIntStats;
  sourcePath: string;
} & ({ role: "global" | "quarantine" | "client" } | { role: "agent"; agentId: string });

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
  resourceRoots?: readonly string[];
}): Promise<{ snapshotPaths: string[]; discoveredSourcePaths: Set<string> }> {
  const snapshotPaths = new Set<string>();
  const discoveredSourcePaths = new Set<string>();
  const visitedDirectories = new Set<string>();
  const gatewayLockDir = resolveGatewayLockDir(params.inventory.stateDir);

  const isRetainedPath = (pathname: string) =>
    !isPathInside(gatewayLockDir, pathname) && !params.inventory.isVolatile(pathname);
  const isSelectedPath = (pathname: string) =>
    !params.resourceRoots ||
    params.resourceRoots.some(
      (root) => isPathInside(root, pathname) || isPathInside(pathname, root),
    );
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
        isSelectedPath(entry.path) &&
        isRetainedPath(entry.path) &&
        classifyBackupSqliteSource(entry.path, params.inventory) === "sqlite",
      descend: (entry) => {
        if (
          visitedDirectories.has(entry.path) ||
          !isSelectedPath(entry.path) ||
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

export async function discoverBackupDatabasePaths(params: {
  stateDir: string;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentRegistry?: readonly OpenClawRegisteredAgentDatabase[];
}): Promise<string[]> {
  if (
    isMainThread &&
    selectDatabaseEngine({ id: "state", postgres: true }, params.config) === "postgres"
  ) {
    const { preparePostgresBackupDiscovery } = await import("./backup-database-discovery.js");
    return (await preparePostgresBackupDiscovery(params)).paths;
  }
  const discovered = await collectStateDatabasePaths(params);
  const paths = [...discovered.values()].flatMap((database) => database.spellings);
  paths.push(
    ...(await resolveAgentPortRoots(
      { ...params, env: params.env ?? process.env },
      params.agentRegistry,
    )),
  );
  const plugins = resolvePluginMetadataSnapshot(params);
  const capable = new Set<string>(
    listDatabaseEngineStores()
      .filter((store) => store.postgres)
      .map((store) => store.id),
  );
  // Retained engine stores remain downgrade-sensitive when their plugin is disabled.
  const retained = plugins.plugins.flatMap((plugin) =>
    (plugin.backupResources ?? [])
      .filter((resource) => capable.has(resource.databaseFamily ?? plugin.id))
      .map((resource) => Object.assign({}, resource, { pluginId: plugin.id })),
  );
  const resources = await createBackupResourcePlan({
    stateDir: params.stateDir,
    configPaths: [],
    oauthDirs: [],
    workspaceDirs: [],
    excludedWorkspaceDirs: [],
    agentRoots: [],
    pluginResources: retained,
    pluginRoots: plugins.plugins.map((plugin) => plugin.rootDir),
  });
  const inventory = sealBackupResourceInventory(resources, []);
  // Core paths are already known; unrelated state cannot contribute plugin stores.
  paths.push(
    ...(
      await discoverBackupSqliteSources({
        inventory,
        resourceRoots: resources.pluginResourceRoots,
      })
    ).snapshotPaths,
  );
  const existing: string[] = [];
  for (const file of new Set(paths)) {
    const info = await fs.stat(file).catch(ignoreMissingSource);
    if (info?.isFile()) {
      existing.push(await fs.realpath(file));
    }
  }
  return [...new Set(existing)].toSorted();
}

async function planBackupSqliteSources(
  inventory: BackupResourceInventory,
  snapshotPaths: readonly string[],
) {
  const sources: Array<{
    archiveSourcePath: string;
    path: string;
    identity: BigIntStats;
    canonicalSource: CanonicalSqliteSource | undefined;
  }> = [];
  for (const archiveSourcePath of snapshotPaths) {
    const identity = await fs.stat(archiveSourcePath, { bigint: true });
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
  postgresSnapshots: Array<{ sourcePath: string; manifestSha256: string }>;
  discoveredSourcePaths: Set<string>;
}> {
  const capturedSnapshots = new Map<BackupSqliteSourceGroup, string>();
  const snapshots: SqliteBackupAsset[] = [];
  const postgresSnapshots: Array<{ sourcePath: string; manifestSha256: string }> = [];
  let capturedAgents: Array<{ role: "agent"; agentId: string; sourcePath: string }> = [];
  function captureAgentRegistry(database: DatabaseSync, archiveSourcePath: string) {
    capturedAgents = readOpenClawAgentDatabaseRegistryRows(database, archiveSourcePath).map(
      (row) => ({
        role: "agent" as const,
        agentId: normalizeAgentId(row.agent_id),
        sourcePath: resolveOpenClawRegisteredAgentDatabasePath(archiveSourcePath, row.path),
      }),
    );
  }
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
      !sameFileIdentity(
        canonicalSource.identity,
        await fs.stat(archiveSourcePath, { bigint: true }),
      )
    ) {
      throw new Error(`Canonical SQLite path changed after discovery: ${archiveSourcePath}`);
    }
    const sourceDatabasePath = sourceGroup.sourcePath;
    assertNotUpdateCapturePath(archiveSourcePath, params.resources.stateDir);
    assertNotUpdateCapturePath(sourceDatabasePath, params.resources.stateDir);
    const sourcePath = path.join(params.tempDir, `openclaw-state-db-${snapshots.length}.sqlite`);
    let hasPostgresAnchor: boolean | undefined;
    try {
      const capture = () =>
        createVerifiedSqliteSnapshot({
          sourcePath: sourceDatabasePath,
          targetPath: sourcePath,
          requireNonEmptySource: Boolean(canonicalSource),
          validate: canonicalSource
            ? (database, pathname) => {
                hasPostgresAnchor ??= readEngineAnchor(database) !== undefined;
                if (hasPostgresAnchor) {
                  return;
                }
                if (canonicalSource.role === "global") {
                  assertOpenClawStateDatabaseOwner(database, { pathname });
                } else if (canonicalSource.role === "agent") {
                  assertOpenClawAgentDatabaseOwner(database, {
                    agentId: canonicalSource.agentId,
                    pathname,
                  });
                }
              }
            : undefined,
          transform: async (database) => {
            hasPostgresAnchor ??= readEngineAnchor(database) !== undefined;
            // Anchors are verified and captured with their PostgreSQL data below.
            if (hasPostgresAnchor) {
              return;
            }
            if (canonicalSource?.role === "global") {
              captureAgentRegistry(database, canonicalSource.archiveSourcePath);
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
            } else if (
              canonicalSource?.role === "client" &&
              tableExists(database, "native_exec_socket_credentials")
            ) {
              // Socket authentication is installation-local and must regenerate on restore.
              executeSqliteQuerySync(
                database,
                getNodeSqliteKysely<ClientCredentialDatabase>(database)
                  .updateTable("native_exec_socket_credentials")
                  .set({ socket_token: null }),
              );
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
    if (readBackupEngineImage(sourcePath, sourceDatabasePath).engine === "postgres") {
      const directory = path.join(
        `${sourcePath}.postgres`,
        path.basename(`${archiveSourcePath}.postgres`),
      );
      await fs.mkdir(path.dirname(directory), { mode: 0o700 });
      await capturePostgresBackup({ sourcePath: sourceDatabasePath, directory });
      if (canonicalSource?.role === "global") {
        using database = openNodeSqliteDatabase(path.join(directory, "database.sqlite"), {
          readOnly: true,
        });
        captureAgentRegistry(database, canonicalSource.archiveSourcePath);
      }
      for (const name of ["anchor.sqlite", "database.sqlite", "manifest.json"]) {
        snapshots.push({
          sourcePath: path.join(directory, name),
          archiveSourcePath: `${archiveSourcePath}.postgres/${name}`,
          skippedSourcePaths: new Set(),
        });
      }
      const anchorPath = `${sourcePath}.anchor`;
      await fs.copyFile(
        path.join(directory, "anchor.sqlite"),
        anchorPath,
        fs.constants.COPYFILE_EXCL,
      );
      snapshots.push({
        sourcePath: anchorPath,
        archiveSourcePath,
        skippedSourcePaths: new Set(resolveSqliteDatabaseFilePaths(sourceDatabasePath)),
      });
      postgresSnapshots.push({
        sourcePath: archiveSourcePath,
        manifestSha256: (await sha256File(path.join(directory, "manifest.json"))).digest,
      });
      return;
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
  const globalEntry = await fs.lstat(globalPath, { bigint: true }).catch(ignoreMissingSource);
  let globalIdentity: BigIntStats | undefined;
  let globalGroup: BackupSqliteSourceGroup | undefined;
  if (globalEntry) {
    globalIdentity = globalEntry.isSymbolicLink()
      ? await fs.stat(globalPath, { bigint: true })
      : globalEntry;
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
      const exists = await fs.lstat(sidecar).catch(ignoreMissingSource);
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
  const defaultDatabases = await listDefaultAgentDatabasePaths(params.resources.stateDir);
  const discoveredDatabasePaths: string[] = [];
  const candidates: Array<BackupCoreDatabase & { discoveredPath?: string }> = [
    {
      role: "client",
      sourcePath: resolveClientCredentialStorePath({
        OPENCLAW_STATE_DIR: params.resources.stateDir,
      }),
    },
    {
      role: "quarantine" as const,
      sourcePath: resolveQuarantineStorePath({
        ...process.env,
        OPENCLAW_STATE_DIR: params.resources.stateDir,
      }),
    },
    ...capturedAgents,
    ...params.resources.agentRoots.map(({ agentId, databasePath }) => ({
      role: "agent" as const,
      agentId,
      sourcePath: databasePath,
    })),
    ...defaultDatabases
      .toSorted((a, b) => a.path.localeCompare(b.path))
      .map(({ agentId, path: sourcePath }) => ({
        role: "agent" as const,
        agentId: normalizeAgentId(agentId),
        sourcePath,
        discoveredPath: sourcePath,
      })),
  ];
  for (const { discoveredPath, ...database } of candidates) {
    const identity = await fs
      .stat(database.sourcePath, { bigint: true })
      .catch(ignoreMissingSource);
    if (identity && !identity.isFile()) {
      throw new Error(`Core SQLite path must resolve to a regular file: ${database.sourcePath}`);
    }
    if (discoveredPath && !identity) {
      continue;
    }
    if (discoveredPath) {
      discoveredDatabasePaths.push(discoveredPath);
      // Keep directory links as links; publish the database at its real archive path.
      database.sourcePath = await fs.realpath(database.sourcePath);
    }
    coreDatabases.push(Object.freeze({ ...database, identity }));
  }
  const inventory = sealBackupResourceInventory(
    {
      ...params.resources,
      protectedPaths: [...params.resources.protectedPaths, ...discoveredDatabasePaths],
    },
    coreDatabases,
  );
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
    if (
      source.identity &&
      !sameFileIdentity(source.identity, await fs.stat(source.sourcePath, { bigint: true }))
    ) {
      throw new Error(`Canonical SQLite path changed after discovery: ${source.sourcePath}`);
    }
  }
  return {
    inventory,
    snapshots,
    postgresSnapshots,
    discoveredSourcePaths: discovery.discoveredSourcePaths,
  };
}
