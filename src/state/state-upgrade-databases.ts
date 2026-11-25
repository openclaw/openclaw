import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { decodeMountInfoPath } from "@openclaw/normalization-core/mountinfo-path";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace-default-path.js";
import { listAgentWorkspaceDirs } from "../agents/workspace-dirs.js";
import { resolveManagedWorktreeRoot } from "../agents/worktrees/storage-root.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { resolveConfiguredAgentDatabaseTargets } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { readEngineAnchorIdentity } from "../infra/database-engine/physical-store-inspection.js";
import { resolveUserPath } from "../infra/home-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { prepareSqliteReadOnlyLocation } from "../infra/sqlite-snapshot-source.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { getMediaDir } from "../media/store-path.js";
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
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-schema-versions.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { readStateSchemaContentVersionRow } from "./openclaw-state-db-schema-version.js";
import { resolveOpenClawRegisteredAgentDatabasePath } from "./openclaw-state-db.paths.js";
import { readUpgradeConfig } from "./state-upgrade-config.js";
import {
  APPLIED_UPGRADE_PREFIX as APPLIED_PREFIX,
  UPGRADE_WORK_PREFIX as WORK_PREFIX,
} from "./state-upgrade-receipts.js";
import { isSqliteFile, isUpgradeRestorePath, withRecoveredSource } from "./state-upgrade-tree.js";

export type DatabaseTarget = {
  kind: "state" | "agent";
  agentId?: string;
  path: string;
  version: number;
  engine: "sqlite" | "postgres";
  postgres?: { namespace: string; physicalBytes: number };
};

export type StateUpgradeInventory = {
  targets: DatabaseTarget[];
  metadataRows: PluginMetadataStateRow[];
  skip: (absolute: string) => boolean;
};

export function readVersion(db: DatabaseSync, kind: DatabaseTarget["kind"]): number {
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
  const retainedAgentDirectories: string[] = [];
  let retainedAgentIds = new Set<string>();
  let registeredAgents: Array<{ agentId: string; path: string }> = [];
  let configuredAgents: Array<{ agentId: string; path: string }> = [];
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
      if (kind === "agent" && configuredAgents.some((target) => target.path === pathname)) {
        targets.push({ kind, agentId, path: pathname, version: 0, engine: "sqlite" });
      }
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
    if (isArtifactPreservingStateRead()) {
      const prepared = await prepareSqliteReadOnlyLocation(pathname, {
        preserveSourceArtifacts: true,
      });
      try {
        image = inspect(prepared.location);
      } finally {
        await prepared.cleanupAsync();
      }
    } else {
      image = withRecoveredSource(pathname, inspect);
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
        engine,
        postgres: { namespace: physical.namespace, physicalBytes: physical.physicalBytes },
      });
    } else {
      targets.push({ kind, agentId, path: pathname, version: image.version, engine });
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
    const agentDirectory = path.join(stateDir, "agents", agentId);
    if (retainedAgentIds.has(agentId)) {
      // Completed retention belongs to deletion, including during another store's upgrade.
      retainedAgentDirectories.push(agentDirectory);
      continue;
    }
    await add(
      "agent",
      path.join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite"),
      agentId,
    );
  }
  configuredAgents = resolveConfiguredAgentDatabaseTargets(config, {
    env,
    registeredDatabases: registeredAgents,
  });
  for (const target of [...registeredAgents, ...configuredAgents]) {
    if (retainedAgentIds.has(target.agentId)) {
      retainedAgentDirectories.push(path.dirname(target.path));
    } else {
      await add("agent", target.path, target.agentId);
    }
  }
  const migrationPaths = new Set<string>();
  for (const target of targets) {
    migrationPaths.add(target.path);
    migrationPaths.add(resolvePathViaExistingAncestorSync(target.path));
  }
  const excludedRoots = [
    resolveDefaultAgentWorkspaceDir(env),
    ...listAgentWorkspaceDirs(config, env),
    ...(config.agents?.defaults?.workspace
      ? [resolveUserPath(config.agents.defaults.workspace, env)]
      : []),
    resolveManagedWorktreeRoot(env),
    resolveManagedWorktreeRoot(env, config.worktreeRoot),
    ...["knowledge", "browser", "backups", "cache", "locks", "tmp", "git-install"].map((name) =>
      path.join(stateDir, name),
    ),
    ...retainedAgentDirectories,
    ...(process.platform === "linux"
      ? fs
          .readFileSync("/proc/self/mountinfo", "utf8")
          .split("\n")
          .map((line) => decodeMountInfoPath(line.split(" ")[4] ?? ""))
          .filter((dir) => dir.startsWith(`${stateDir}${path.sep}`))
      : []),
  ].flatMap((dir) => {
    const absolute = path.resolve(dir);
    return fs.existsSync(absolute) ? [absolute, fs.realpathSync(absolute)] : [absolute];
  });
  const media = getMediaDir({ ...env, OPENCLAW_STATE_DIR: stateDir });
  const mediaRecords = path.join(media, "outgoing", "records");
  const within = (file: string, dir: string) =>
    file === dir || file.startsWith(`${dir}${path.sep}`);
  const skip = (absolute: string) => {
    const top = path.relative(stateDir, absolute).split(path.sep)[0] ?? "";
    if (
      top.startsWith(WORK_PREFIX) ||
      top.startsWith(APPLIED_PREFIX) ||
      excludedRoots.some((dir) => within(absolute, dir)) ||
      (within(absolute, media) &&
        !within(mediaRecords, absolute) &&
        !within(absolute, mediaRecords))
    ) {
      return true;
    }
    if (migrationPaths.has(absolute)) {
      return false;
    }
    // Large unregistered SQLite images are not Doctor inputs.
    const stat = fs.statSync(absolute, { throwIfNoEntry: false });
    return (
      stat !== undefined && stat.isFile() && stat.size > 64 * 1024 ** 2 && isSqliteFile(absolute)
    );
  };
  return { targets, metadataRows, skip };
}

export const expectedVersion = (target: Pick<DatabaseTarget, "kind">) =>
  target.kind === "state" ? OPENCLAW_STATE_SCHEMA_VERSION : OPENCLAW_AGENT_SCHEMA_VERSION;

/** Version zero is a fresh catalog; normal bootstrap owns it. */
export function outdatedDatabases(targets: readonly DatabaseTarget[]): DatabaseTarget[] {
  return targets.filter((target) => target.version > 0 && target.version < expectedVersion(target));
}

/**
 * Whether this start must take state ownership: an interrupted swap to finish or a
 * database older than this build. Read-only, so a start that another live owner
 * refuses learns that from its usual admission check.
 */
export async function isStateUpgradePending(env: NodeJS.ProcessEnv): Promise<boolean> {
  const stateDir = path.resolve(resolveStateDir(env));
  if (!fs.existsSync(stateDir)) {
    return false;
  }
  if (fs.readdirSync(stateDir).some((entry) => entry.startsWith(WORK_PREFIX))) {
    return true;
  }
  const { config } = readUpgradeConfig(resolveConfigPath(env, stateDir));
  return outdatedDatabases((await discoverDatabases(stateDir, config, env)).targets).length > 0;
}

/** Admission uses the same inventory and exclusions as the private copy. */
export function stateUpgradeRefusal(
  { targets, skip }: StateUpgradeInventory,
  stateDir: string,
): string | undefined {
  if (outdatedDatabases(targets).length === 0) {
    return undefined;
  }
  const realStateDir = fs.realpathSync(stateDir);
  const device = fs.statSync(stateDir).dev;
  for (const target of targets) {
    const relative = path.relative(stateDir, target.path);
    const stat = fs.statSync(target.path, { throwIfNoEntry: false });
    if (
      !isUpgradeRestorePath(stateDir, target.path) ||
      path.relative(realStateDir, resolvePathViaExistingAncestorSync(target.path)) !== relative ||
      (stat !== undefined && stat.dev !== device) ||
      skip(target.path)
    ) {
      return `The release trial cannot restore database ${target.path}. Move it to a real directory inside ${stateDir}, at most four directories deep and outside git-install, npm, node_modules, tmp and logs. For an agent use agents/<agent-id>/agent/openclaw-agent.sqlite, without backup or companion suffixes, and update its registration/configuration. Replace symlinked or separately mounted directories with local directories before retrying openclaw update.`;
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
    : { targets: [], metadataRows: [], skip: () => false };
  for (const target of inventory.targets) {
    const supported = expectedVersion(target);
    if (target.version > supported) {
      throw new Error(
        `${target.kind}-schema-newer: on-disk schema ${target.version} is newer than this build's ${supported}`,
      );
    }
  }
  const refusal = stateUpgradeRefusal(inventory, stateDir);
  if (refusal) {
    throw new Error(refusal);
  }
  const postgres = inventory.targets.filter((target) => target.engine === "postgres");
  if (postgres.length > 0 && outdatedDatabases(inventory.targets).length > 0) {
    await preflightPostgresUpgrade(
      postgres.map((target) => target.path),
      config,
    );
  }
  return inventory;
}
