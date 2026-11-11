import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { readEngineAnchorIdentity } from "../infra/database-engine/physical-store.js";
import { openNodeSqliteDatabase, resolveImmutableSqliteFileUri } from "../infra/node-sqlite.js";
import { readFiniteSqliteNumber } from "../infra/sqlite-number.js";
import { readSqlitePageHeader } from "../infra/sqlite-schema-catalog.js";
import type { AgentDatabaseMigrationTarget } from "../infra/state-migrations.media-persistence-targets.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

/** Inspect only after the maintenance owner has drained its readers and writers. */
export async function inspectDoctorSqliteReclamation(params: {
  env: NodeJS.ProcessEnv;
  agents: readonly AgentDatabaseMigrationTarget[];
  signal: AbortSignal;
  assertCurrent: () => void;
}): Promise<{ warnings: string[] }> {
  const targets = [
    { path: resolveOpenClawStateSqlitePath(params.env), agentId: undefined },
    ...params.agents,
  ];
  const warnings: string[] = [];
  const visited = new Set<string>();
  for (const target of targets) {
    await setImmediate();
    params.signal.throwIfAborted();
    params.assertCurrent();
    const sqlitePath = path.resolve(target.path);
    if (visited.has(sqlitePath)) {
      continue;
    }
    visited.add(sqlitePath);
    if (!fs.existsSync(sqlitePath)) {
      continue;
    }
    const command =
      target.agentId === undefined
        ? "openclaw doctor --state-sqlite compact"
        : "openclaw doctor --session-sqlite compact --session-sqlite-all-agents";
    // Immutable reads ignore recovery pages. Defer instead of copying a whole
    // database or checkpointing it merely to decide whether maintenance is useful.
    if (
      fs.existsSync(`${sqlitePath}-journal`) ||
      (fs.statSync(`${sqlitePath}-wal`, { throwIfNoEntry: false })?.size ?? 0) > 0
    ) {
      warnings.push(
        `SQLite reclamation inspection deferred for ${sqlitePath}: recovery pages remain. If compaction is needed, run ${command} during explicit maintenance.`,
      );
      continue;
    }
    using database = openNodeSqliteDatabase(resolveImmutableSqliteFileUri(sqlitePath), {
      readOnly: true,
    });
    if (readEngineAnchorIdentity(database, sqlitePath).engine === "postgres") {
      continue;
    }
    const mode = readFiniteSqliteNumber(database.prepare("PRAGMA auto_vacuum").get()?.auto_vacuum);
    const free = readFiniteSqliteNumber(readSqlitePageHeader(database).free);
    if (mode === 0) {
      warnings.push(
        `SQLite reclamation deferred for ${sqlitePath}: enabling incremental reclamation requires a full rewrite (${free ?? "unknown"} free pages). Run ${command} during explicit maintenance; updates do not VACUUM databases.`,
      );
    }
  }
  return { warnings };
}
