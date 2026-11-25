import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveStateDir } from "../config/paths.js";
import { resolveConfiguredAgentDatabaseTargets } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { readEngineAnchorIdentity } from "../infra/database-engine/physical-store-inspection.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { prepareSqliteReadOnlyLocation } from "../infra/sqlite-snapshot-source.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
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
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-schema-versions.js";
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
  return { targets, metadataRows };
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
    const additive =
      target.kind === "agent" &&
      target.version === AGENT_MEMBER_ACCESS_SCHEMA_VERSION - 1 &&
      supported === AGENT_MEMBER_ACCESS_SCHEMA_VERSION &&
      getAgentMemberAccessMinReader() < supported;
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
  const realStateDir = fs.realpathSync(stateDir);
  const device = fs.statSync(stateDir).dev;
  for (const target of protectedTargets) {
    const relative = path.relative(stateDir, target.path);
    const stat = fs.statSync(target.path, { throwIfNoEntry: false });
    // An absent store is restored by the existing addition-removal receipt, not the scan.
    if (!stat) {
      continue;
    }
    if (
      !isUpgradeRestorePath(stateDir, target.path) ||
      path.relative(realStateDir, resolvePathViaExistingAncestorSync(target.path)) !== relative ||
      (stat !== undefined && stat.dev !== device)
    ) {
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

function isUpgradeRestorePath(stateDir: string, file: string): boolean {
  const relative = path.relative(stateDir, file);
  const parts = relative.split(path.sep);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative) &&
    parts.length <= 5 &&
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
