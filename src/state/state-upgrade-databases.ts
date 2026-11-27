import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { decodeMountInfoPath } from "@openclaw/normalization-core/mountinfo-path";
import { listLegacyAuthProfileSources } from "../agents/auth-profiles/legacy-source-files.js";
import { inspectSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import {
  hasPendingSharedAuthCleanup,
  inspectSharedAuthLegacySourceFile,
  inspectSharedAuthLegacyRowsReadOnlyAsync,
} from "../agents/auth-profiles/shared-store-bootstrap.js";
import { resolveAgentSessionDirs } from "../agents/session-dirs.js";
import { listUnreferencedJsonlFiles } from "../commands/doctor-session-sqlite-discovery.js";
import { createConfigRuntimeEnv } from "../config/config-env-vars.js";
import { resolveOAuthDir, resolveStateDir } from "../config/paths.js";
import {
  resolveConfiguredAgentDatabaseTargets,
  resolveConfiguredSessionStoreTargets,
} from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { readEngineAnchorIdentity } from "../infra/database-engine/physical-store-inspection.js";
import { hasErrnoCode } from "../infra/errno.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { listLegacyPairingStoreFiles } from "../infra/pairing-files.js";
import { prepareSqliteReadOnlyLocation } from "../infra/sqlite-snapshot-source.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { detectLegacyApnsRegistrations } from "../infra/state-migrations.apns.js";
import { detectLegacyAuditLogs } from "../infra/state-migrations.audit-checkpoints.js";
import { detectLegacyChannelPairingState } from "../infra/state-migrations.channel-pairing.js";
import { detectLegacyCommitments } from "../infra/state-migrations.commitments.js";
import { detectLegacyDebugProxyCaptureSidecar } from "../infra/state-migrations.debug-proxy.js";
import { detectLegacyDeviceAuth } from "../infra/state-migrations.device-auth.js";
import {
  detectLegacyDeviceIdentity,
  hasLegacyDeviceIdentityPath,
} from "../infra/state-migrations.device-identity-repair.js";
import { detectLegacyExecApprovals } from "../infra/state-migrations.exec-approvals.js";
import { resolveLegacyStateMigrationOwner } from "../infra/state-migrations.legacy-owner.js";
import { inspectLegacyAgentDir } from "../infra/state-migrations.legacy-sessions.js";
import { detectLegacyManagedOutgoingImages } from "../infra/state-migrations.managed-outgoing-images.js";
import { detectLegacyMcpOAuthStores } from "../infra/state-migrations.mcp-oauth.js";
import { detectLegacyMeetingTranscripts } from "../infra/state-migrations.meeting-transcripts-detection.js";
import { detectLegacyNodeHostConfig } from "../infra/state-migrations.node-host.js";
import { resolveLegacyProfileMigrationExceptions } from "../infra/state-migrations.profile-scope.js";
import { detectLegacyRescuePending } from "../infra/state-migrations.rescue-pending.js";
import { listRetiredDeliveryQueueFiles } from "../infra/state-migrations.retired-delivery-files.js";
import {
  listExistingRetiredStateFiles,
  RetiredStateFormatError,
} from "../infra/state-migrations.retired-files.js";
import { listRetiredRuntimeStateFiles } from "../infra/state-migrations.retired-runtime-files.js";
import { resolveLegacyConfigHealthPath } from "../infra/state-migrations.runtime-state.js";
import { resolveSharedAuthMigrationSources } from "../infra/state-migrations.shared-auth-store.js";
import { detectLegacyTuiLastSessions } from "../infra/state-migrations.tui-last-session.js";
import { detectLegacyWebPush } from "../infra/state-migrations.web-push.js";
import { detectLegacyWorkspaceState } from "../infra/state-migrations.workspace-setup.js";
import { resolveLegacyInstalledPluginIndexStorePath } from "../plugins/installed-plugin-index-store-path.js";
import {
  readPluginMetadataStateRowsInDatabase,
  type PluginMetadataStateRow,
} from "../plugins/plugin-metadata-state.kernel.js";
import { inspectPostgresUpgrade, preflightPostgresUpgrade } from "../snapshot/database-backup.js";
import { readRetainedAgentDeletionIds } from "./agent-deletion-journal.snapshot.worker.js";
import {
  isArtifactPreservingStateRead,
  withArtifactPreservingStateReads,
} from "./artifact-preserving-state-reads.js";
import { readAgentDatabasePreflightTargets } from "./openclaw-agent-db-registry.read.js";
import { readExistingAgentSchemaMeta } from "./openclaw-agent-db-schema-read.js";
import {
  AGENT_MEMBER_ACCESS_SCHEMA_VERSION,
  getAgentMemberAccessMinReader,
} from "./openclaw-agent-member-access-schema.js";
import {
  AGENT_ARCHIVE_UNDO_SCHEMA_VERSION,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "./openclaw-schema-versions.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  readStateSchemaContentVersionRow,
  readStateSchemaMinReader,
} from "./openclaw-state-db-schema-version.js";
import { resolveOpenClawRegisteredAgentDatabasePath } from "./openclaw-state-db.paths.js";

export type DatabaseTarget = {
  kind: "state" | "agent";
  agentId?: string;
  path: string;
  version: number;
  minReader: number;
  engine: "sqlite" | "postgres";
  postgres?: { namespace: string; physicalBytes: number };
};

export type StateUpgradeInventory = {
  targets: DatabaseTarget[];
  metadataRows: PluginMetadataStateRow[];
};

function readVersion(db: DatabaseSync, kind: DatabaseTarget["kind"]): number {
  const user = readSqliteUserVersion(db);
  if (kind !== "state") {
    return user;
  }
  try {
    const row = readStateSchemaContentVersionRow(db);
    return Math.max(user, Number(row?.value_json ?? 0) || 0);
  } catch {
    return user;
  }
}

export async function discoverDatabases(
  stateDir: string,
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Promise<StateUpgradeInventory> {
  const targets: DatabaseTarget[] = [];
  let metadataRows: PluginMetadataStateRow[] = [];
  let retainedAgentIds = new Set<string>();
  let registeredAgents: Array<{ agentId: string; path: string }> = [];
  const add = async (kind: DatabaseTarget["kind"], inputPath: string, agentId?: string) => {
    const pathname = path.resolve(inputPath);
    if (targets.some((target) => target.path === pathname)) {
      return;
    }
    const stat = fs.statSync(pathname, { throwIfNoEntry: false });
    if (!stat || stat.size === 0) {
      if (
        ["-wal", "-journal"].some(
          (suffix) =>
            (fs.statSync(`${pathname}${suffix}`, { throwIfNoEntry: false })?.size ?? 0) > 0,
        )
      ) {
        throw new Error(
          `Database family ${pathname} is incomplete. Preserve its WAL/journal and restore the matching database backup before retrying the update.`,
        );
      }
      targets.push({ kind, agentId, path: pathname, version: 0, minReader: 0, engine: "sqlite" });
      return;
    }
    if (!isSqliteFile(pathname)) {
      throw new Error(
        `Cannot inspect database ${pathname}. Run openclaw doctor with the current version before retrying the update.`,
      );
    }
    const inspect = (readable: string) => {
      using db = openNodeSqliteDatabase(readable, { readOnly: true });
      return {
        engine: readEngineAnchorIdentity(db, pathname).engine,
        version: readVersion(db, kind),
        minReader:
          kind === "state"
            ? readStateSchemaMinReader(db)
            : (readExistingAgentSchemaMeta(db)?.minReader ?? readSqliteUserVersion(db)),
        state:
          kind === "state"
            ? {
                metadataRows: readPluginMetadataStateRowsInDatabase(db, [
                  "plugins.installedIndex",
                  "plugins.bundledDiscovery",
                ]),
                retainedIds: new Set(readRetainedAgentDeletionIds(db)),
                registered: readAgentDatabasePreflightTargets(db, pathname),
              }
            : undefined,
      };
    };
    let image;
    if (
      isArtifactPreservingStateRead() ||
      (fs.statSync(`${pathname}-journal`, { throwIfNoEntry: false })?.size ?? 0) > 0
    ) {
      const prepared = await prepareSqliteReadOnlyLocation(pathname, {
        preserveSourceArtifacts: true,
      });
      try {
        image = inspect(prepared.location);
      } finally {
        await prepared.cleanupAsync();
      }
    } else {
      image = inspect(pathname);
    }
    if (image.state) {
      metadataRows = image.state.metadataRows;
      retainedAgentIds = image.state.retainedIds;
      registeredAgents = image.state.registered;
    }
    const { engine } = image;
    if (engine === "postgres") {
      const physical = await inspectPostgresUpgrade(pathname, config);
      if (kind === "state") {
        retainedAgentIds = new Set(physical.retainedAgentIds);
        registeredAgents = physical.registeredAgentDatabases.map((entry) => ({
          ...entry,
          path: resolveOpenClawRegisteredAgentDatabasePath(pathname, entry.path),
        }));
      }
      targets.push({
        kind,
        agentId,
        path: pathname,
        version: physical.version,
        minReader: physical.minReader,
        engine,
        postgres: { namespace: physical.namespace, physicalBytes: physical.physicalBytes },
      });
    } else {
      targets.push({
        kind,
        agentId,
        path: pathname,
        version: image.version,
        minReader: image.minReader,
        engine,
      });
    }
  };
  await add("state", path.join(stateDir, "state", "openclaw.sqlite"));
  let agents: string[] = [];
  try {
    agents = fs.readdirSync(path.join(stateDir, "agents"));
  } catch {
    // No agents yet.
  }
  for (const agentId of agents) {
    if (retainedAgentIds.has(agentId)) {
      // Completed retention belongs to deletion, including during another store's upgrade.
      continue;
    }
    await add(
      "agent",
      path.join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite"),
      agentId,
    );
  }
  const configuredAgents = resolveConfiguredAgentDatabaseTargets(config, {
    env,
    registeredDatabases: registeredAgents,
  });
  for (const target of [...registeredAgents, ...configuredAgents]) {
    if (!retainedAgentIds.has(target.agentId)) {
      await add("agent", target.path, target.agentId);
    }
  }
  if (!targets.some((target) => target.version === 0)) {
    return { targets, metadataRows };
  }

  // Fresh catalogs belong to bootstrap, not schema rollback. Only retained
  // legacy sources can make an import create them during this upgrade. Use
  // source owners here: the full detector needs already-migrated agent readers.
  return {
    targets: (await hasLegacyStateSources(stateDir, config, env, targets))
      ? targets
      : targets.filter((target) => target.version !== 0),
    metadataRows,
  };
}

/** Inspect retained source facts without opening an agent for schema repair. */
export async function hasLegacyStateSources(
  stateDir: string,
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  targets: readonly DatabaseTarget[],
): Promise<boolean> {
  const doctorSources = { stateDir, env, doctorOnlyStateMigrations: true };
  let hasLegacySource = await withArtifactPreservingStateReads(
    async () =>
      listExistingRetiredStateFiles([
        resolveLegacyInstalledPluginIndexStorePath({ stateDir }),
        resolveLegacyConfigHealthPath(stateDir),
        ...listRetiredRuntimeStateFiles(stateDir, env),
      ]).length > 0 ||
      listRetiredDeliveryQueueFiles(stateDir).length > 0 ||
      (await listLegacyPairingStoreFiles(stateDir)).length > 0 ||
      detectLegacyDebugProxyCaptureSidecar(stateDir, env).hasLegacy ||
      detectLegacyTuiLastSessions(doctorSources).hasLegacy ||
      detectLegacyApnsRegistrations(doctorSources).hasLegacy ||
      detectLegacyDeviceAuth(doctorSources).hasLegacy ||
      detectLegacyDeviceIdentity({ stateDir }).sources.some(hasLegacyDeviceIdentityPath) ||
      detectLegacyExecApprovals(doctorSources).hasLegacy ||
      detectLegacyMcpOAuthStores(doctorSources).hasLegacy ||
      detectLegacyManagedOutgoingImages(doctorSources).hasLegacy ||
      detectLegacyWebPush(doctorSources).hasLegacy ||
      detectLegacyNodeHostConfig(doctorSources).hasLegacy ||
      detectLegacyRescuePending(doctorSources).hasLegacy ||
      detectLegacyAuditLogs(doctorSources).hasLegacy ||
      (await detectLegacyCommitments(doctorSources)).hasLegacy ||
      (
        await detectLegacyMeetingTranscripts({
          ...doctorSources,
          artifactPreservingReadOnly: true,
        })
      ).hasLegacy ||
      (await detectLegacyWorkspaceState({ ...doctorSources, cfg: config })).hasLegacy ||
      detectLegacyChannelPairingState({
        sourceDir: resolveOAuthDir(createConfigRuntimeEnv(config, env), stateDir),
        configuredChannelIds: Object.keys(config.channels ?? {}),
        deferConfiguredAccountDiscovery: true,
      }).hasLegacy,
    { agentDatabases: true },
  ).catch((error: unknown) => {
    if (
      error instanceof RetiredStateFormatError &&
      (hasErrnoCode(error.cause, "EACCES") || hasErrnoCode(error.cause, "EPERM"))
    ) {
      // Startup's warning owner reports unreadable retired files without importing them.
      return false;
    }
    throw error;
  });

  if (!hasLegacySource) {
    const sessionStores = [
      ...resolveConfiguredSessionStoreTargets(config, env).map((target) => target.storePath),
      ...(await resolveAgentSessionDirs(stateDir)).map((dir) => path.join(dir, "sessions.json")),
    ];
    hasLegacySource = sessionStores.some(
      (storePath) =>
        listExistingRetiredStateFiles([storePath]).length > 0 ||
        listUnreferencedJsonlFiles(storePath, []).length > 0,
    );
  }
  if (!hasLegacySource) {
    const authSources = resolveSharedAuthMigrationSources(config, env);
    hasLegacySource =
      listLegacyAuthProfileSources({ env }).length > 0 ||
      [
        ...targets
          .filter((target) => target.kind === "agent")
          .map((target) => path.dirname(target.path)),
        ...authSources.map((source) => path.dirname(source.sourcePath)),
      ].some((agentDir) => listLegacyAuthProfileSources({ agentDir, env }).length > 0);
    if (!hasLegacySource) {
      const ownership = inspectSharedAuthStoreOwnership(env);
      for (const { sourcePath } of authSources) {
        if (hasPendingSharedAuthCleanup(env, sourcePath, { artifactPreservingReadOnly: true })) {
          hasLegacySource = true;
          break;
        }
        if (ownership.location !== "legacy-main") {
          continue;
        }
        const source = inspectSharedAuthLegacySourceFile(sourcePath);
        if (source.status === "present" && source.size > 0) {
          const rows = await inspectSharedAuthLegacyRowsReadOnlyAsync(sourcePath, {
            artifactPreservingReadOnly: isArtifactPreservingStateRead(),
          });
          if (rows.store || rows.state) {
            hasLegacySource = true;
            break;
          }
        }
      }
    }
  }
  if (!hasLegacySource) {
    const { migrationTarget } = resolveLegacyStateMigrationOwner({
      cfg: config,
      locatorConfig: config,
      env,
      homedir: os.homedir,
    });
    const { standaloneAgent } = resolveLegacyProfileMigrationExceptions({
      env,
      configuredAgentDir: migrationTarget?.dir,
    });
    for (const source of new Set([
      path.join(stateDir, "agent"),
      ...(standaloneAgent ? [standaloneAgent] : []),
    ])) {
      if (
        migrationTarget?.dir &&
        resolvePathViaExistingAncestorSync(source) ===
          resolvePathViaExistingAncestorSync(migrationTarget.dir)
      ) {
        continue;
      }
      const inspection = await withArtifactPreservingStateReads(
        () => inspectLegacyAgentDir(source),
        { agentDatabases: true },
      );
      if (inspection.status === "failed") {
        throw new Error(inspection.warning);
      }
      if (inspection.status === "payload") {
        hasLegacySource = true;
        break;
      }
    }
  }
  return hasLegacySource;
}

export const expectedVersion = (target: Pick<DatabaseTarget, "kind">) =>
  target.kind === "state" ? OPENCLAW_STATE_SCHEMA_VERSION : OPENCLAW_AGENT_SCHEMA_VERSION;

/** Version zero is a fresh catalog; normal bootstrap owns it. */
export function outdatedDatabases(targets: readonly DatabaseTarget[]): DatabaseTarget[] {
  return targets.filter((target) => target.version > 0 && target.version < expectedVersion(target));
}

/** Only a raised reader floor needs a rollback image. Keep classification with inventory. */
export function floorRaisingDatabases(targets: readonly DatabaseTarget[]): DatabaseTarget[] {
  return targets.filter((target) => {
    const supported = expectedVersion(target);
    // v44 and v45 add only nullable columns. Revisit this range when a later step raises the floor.
    const additive =
      target.kind === "agent" &&
      target.version >= AGENT_MEMBER_ACCESS_SCHEMA_VERSION - 1 &&
      supported <= AGENT_ARCHIVE_UNDO_SCHEMA_VERSION &&
      getAgentMemberAccessMinReader() < AGENT_MEMBER_ACCESS_SCHEMA_VERSION;
    return target.version < supported && !additive && supported > target.minReader;
  });
}

/** The resident launcher still restores build-named images through its frozen scan. */
export function stateUpgradeRefusal(
  { targets }: StateUpgradeInventory,
  stateDir: string,
): string | undefined {
  const protectedTargets = floorRaisingDatabases(targets);
  if (protectedTargets.length === 0) {
    return undefined;
  }
  for (const target of protectedTargets) {
    if (!isUpgradeRestorePath(stateDir, target.path)) {
      return `The release trial cannot restore database ${target.path} after raising its reader floor. Move it to a real directory inside ${stateDir}, at most four directories deep and outside git-install, npm, node_modules, tmp and logs. For an agent use agents/<agent-id>/agent/openclaw-agent.sqlite, without backup or companion suffixes, and update its registration/configuration. Replace symlinked or separately mounted directories with local directories before retrying openclaw update.`;
    }
  }
  return undefined;
}

/** Candidate preparation runs this read-only check while the previous Gateway serves. */
export async function preflightStateUpgrade(
  env: NodeJS.ProcessEnv,
  config: OpenClawConfig,
): Promise<StateUpgradeInventory> {
  const stateDir = path.resolve(resolveStateDir(env));
  const inventory: StateUpgradeInventory = fs.existsSync(stateDir)
    ? await withArtifactPreservingStateReads(() => discoverDatabases(stateDir, config, env))
    : { targets: [], metadataRows: [] };
  for (const target of inventory.targets) {
    const supported = expectedVersion(target);
    if (target.minReader > supported) {
      throw new Error(
        `${target.kind}-schema-newer: on-disk reader floor ${target.minReader} exceeds this build's ${supported}`,
      );
    }
  }
  const refusal = stateUpgradeRefusal(inventory, stateDir);
  if (refusal) {
    throw new Error(refusal);
  }
  const protectedTargets = floorRaisingDatabases(inventory.targets);
  const postgres = protectedTargets.filter((target) => target.engine === "postgres");
  if (postgres.length > 0) {
    await preflightPostgresUpgrade(
      postgres.map((target) => target.path),
      config,
    );
  }
  return inventory;
}

function isSqliteFile(pathname: string): boolean {
  const header = Buffer.from("SQLite format 3\0", "latin1");
  const fd = fs.openSync(pathname, "r");
  try {
    const actual = Buffer.alloc(header.length);
    return fs.readSync(fd, actual, 0, actual.length, 0) === actual.length && actual.equals(header);
  } finally {
    fs.closeSync(fd);
  }
}

/** Paths whose build-named image the frozen launcher can discover and rename. */
export function isUpgradeRestorePath(stateDir: string, file: string): boolean {
  // Absent stores use the launcher's existing addition-removal receipt.
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat) {
    return true;
  }
  const relative = path.relative(stateDir, file);
  const parts = relative.split(path.sep);
  const canonical = resolvePathViaExistingAncestorSync(file);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative) &&
    parts.length <= 5 &&
    path.relative(fs.realpathSync(stateDir), canonical) === relative &&
    stat.dev === fs.statSync(stateDir).dev &&
    (process.platform !== "linux" ||
      !fs
        .readFileSync("/proc/self/mountinfo", "utf8")
        .split("\n")
        .some((line) => decodeMountInfoPath(line.split(" ")[4] ?? "") === canonical)) &&
    !parts.some(
      (part, index) =>
        /\.pre-[^/]+$|\.pre-startup-migration-|\.scoped\.bak$|\.sqlite[^/]*\.bak$|^openclaw-media-persistence-recovery-|-(wal|shm|journal)$|\.seal$/u.test(
          part,
        ) ||
        (index < parts.length - 1 &&
          ["git-install", "npm", "node_modules", "tmp", "logs"].includes(part)),
    )
  );
}
