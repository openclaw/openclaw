import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import JSON5 from "json5";
import { resolveConfigIncludes } from "../config/includes.js";
import { coerceConfig } from "../config/io.read-helpers.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { resolveConfiguredAgentDatabaseTargets } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readBackupEngine } from "../infra/database-engine/physical-store.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { inspectPostgresUpgrade, preflightPostgresUpgrade } from "../snapshot/database-backup.js";
import { readRetainedAgentDeletionIds } from "./agent-deletion-journal.snapshot.worker.js";
import { readAgentDatabasePreflightTargets } from "./openclaw-agent-db-registry.read.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-schema-versions.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { readStateSchemaContentVersionRow } from "./openclaw-state-db-schema-version.js";
import { resolveOpenClawRegisteredAgentDatabasePath } from "./openclaw-state-db.paths.js";
import { UPGRADE_WORK_PREFIX as WORK_PREFIX } from "./state-upgrade-receipts.js";
import { isSqliteFile, withRecoveredSource } from "./state-upgrade-tree.js";

export type DatabaseTarget = {
  kind: "state" | "agent";
  agentId?: string;
  path: string;
  version: number;
  engine: "sqlite" | "postgres";
  postgres?: { namespace: string; physicalBytes: number };
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

function openReadOnly(pathname: string): DatabaseSync {
  return openNodeSqliteDatabase(pathname, { readOnly: true });
}

export async function discoverDatabases(
  stateDir: string,
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Promise<{ targets: DatabaseTarget[]; retainedAgentDirectories: string[] }> {
  const targets: DatabaseTarget[] = [];
  const retainedAgentDirectories: string[] = [];
  let retainedAgentIds = new Set<string>();
  let registeredAgents: Array<{ agentId: string; path: string }> = [];
  const realStateDir = fs.realpathSync(stateDir);
  const add = async (kind: DatabaseTarget["kind"], pathname: string, agentId?: string) => {
    const relative = path.relative(stateDir, pathname);
    // External, deep and symlinked stores keep the existing Doctor path: installed
    // launchers cannot restore those anchors from this state's generation inventory.
    if (
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      relative.split(path.sep).length > 5 ||
      targets.some((target) => target.path === pathname) ||
      !isSqliteFile(pathname)
    ) {
      return;
    }
    // Accepted edge case: the swap cannot rename across a symlinked directory, so a
    // database there keeps the previous upgrade path (Doctor) instead.
    if (
      path.relative(realStateDir, fs.realpathSync(path.dirname(pathname))) !==
      path.relative(stateDir, path.dirname(pathname))
    ) {
      return;
    }
    const engine = readBackupEngine(pathname).engine;
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
      return;
    }
    const version = withRecoveredSource(pathname, (readable) => {
      const db = openReadOnly(readable);
      try {
        if (kind === "state") {
          retainedAgentIds = new Set(readRetainedAgentDeletionIds(db));
          registeredAgents = readAgentDatabasePreflightTargets(db, pathname);
        }
        return readVersion(db, kind);
      } finally {
        db.close();
      }
    });
    targets.push({ kind, agentId, path: pathname, version, engine });
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
  for (const target of [
    ...registeredAgents,
    ...resolveConfiguredAgentDatabaseTargets(config, {
      env,
      registeredDatabases: registeredAgents,
    }),
  ]) {
    if (retainedAgentIds.has(target.agentId)) {
      retainedAgentDirectories.push(path.dirname(target.path));
    } else {
      await add("agent", target.path, target.agentId);
    }
  }
  return { targets, retainedAgentDirectories };
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
  const config = readUpgradeConfig(resolveConfigPath(env, stateDir));
  return outdatedDatabases((await discoverDatabases(stateDir, config, env)).targets).length > 0;
}

export function readUpgradeConfig(configPath: string): OpenClawConfig {
  try {
    // Doctor owns validation and migration; path resolvers tolerate legacy shapes.
    return coerceConfig(
      resolveConfigIncludes(JSON5.parse(fs.readFileSync(configPath, "utf8")), configPath),
    );
  } catch {
    return {};
  }
}

/** Use the measured 90 seconds/GiB copy rate within the ten-minute update window. */
export function postgresInPlaceUpgradeNotice(
  targets: readonly DatabaseTarget[],
): string | undefined {
  const namespaces = new Map<string, number>();
  for (const target of targets) {
    if (target.postgres) {
      namespaces.set(target.postgres.namespace, target.postgres.physicalBytes);
    }
  }
  let bytes = 0;
  for (const size of namespaces.values()) {
    bytes += size;
  }
  const gib = bytes / 1024 ** 3;
  if (gib * 90 <= 600) {
    return undefined;
  }
  return `This PostgreSQL store (${gib.toFixed(2)} GiB) is too large to copy within the update window. It is migrated in place, without automatic data rollback. Back it up first: https://docs.openclaw.ai/install/updating#rollback`;
}

/** Candidate preparation runs this read-only check while the previous Gateway serves. */
export async function preflightStateUpgrade(
  env: NodeJS.ProcessEnv,
  config: OpenClawConfig,
): Promise<string | undefined> {
  const stateDir = path.resolve(resolveStateDir(env));
  if (!fs.existsSync(stateDir)) {
    return undefined;
  }
  const { targets } = await discoverDatabases(stateDir, config, env);
  const postgres = targets.filter((target) => target.engine === "postgres");
  if (postgres.length > 0 && outdatedDatabases(targets).length > 0) {
    const notice = postgresInPlaceUpgradeNotice(targets);
    if (notice) {
      return notice;
    }
    await preflightPostgresUpgrade(
      postgres.map((target) => target.path),
      config,
    );
  }
  return undefined;
}
