import path from "node:path";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { readActiveUpdateRun } from "../infra/update-run-reader.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";
import { assertOpenClawStateDatabaseForMaintenance } from "./openclaw-state-db-maintenance.js";
import type { AgentDatabases, DB } from "./openclaw-state-db.generated.js";
import {
  resolveOpenClawAgentDatabaseStoredPath,
  resolveOpenClawRegisteredAgentDatabasePath,
} from "./openclaw-state-db.paths.js";

export type AgentDatabasePathRepairReport = { repaired: number; warnings: string[] };

/** The caller retains shared-state write admission through this synchronous repair. */
export function repairOpenClawAgentDatabasePathAliases(
  database: Pick<OpenClawStateDatabase, "db" | "path">,
): AgentDatabasePathRepairReport {
  const { db, path: pathname } = database;
  assertOpenClawStateDatabaseForMaintenance(db, { pathname });
  const active = readActiveUpdateRun(db);
  if (active) {
    return {
      repaired: 0,
      warnings: [
        `Skipped agent database path repair while update ${active.runId} is in progress. Run openclaw doctor --fix after the update finishes.`,
      ],
    };
  }

  const queries = getNodeSqliteKysely<Pick<DB, "agent_databases">>(db);
  const rows = executeSqliteQuerySync(
    db,
    queries
      .selectFrom("agent_databases")
      .selectAll()
      .orderBy("last_seen_at", "desc")
      .orderBy("path"),
  ).rows;
  const agents = new Map<string, Map<string, AgentDatabases[]>>();
  for (const row of rows) {
    const stored = resolveOpenClawAgentDatabaseStoredPath(
      pathname,
      resolveOpenClawRegisteredAgentDatabasePath(pathname, row.path),
    );
    if (path.isAbsolute(stored)) {
      continue;
    }
    let paths = agents.get(row.agent_id);
    if (!paths) {
      paths = new Map();
      agents.set(row.agent_id, paths);
    }
    const aliases = paths.get(stored) ?? [];
    aliases.push(row);
    paths.set(stored, aliases);
  }

  let repaired = 0;
  for (const [agentId, paths] of agents) {
    for (const [stored, aliases] of paths) {
      if (!aliases.some((row) => row.path.startsWith("\\\\?\\"))) {
        continue;
      }
      const newest = aliases[0]!;
      executeSqliteQuerySync(
        db,
        queries
          .insertInto("agent_databases")
          .values({ ...newest, path: stored })
          .onConflict((conflict) =>
            conflict.columns(["agent_id", "path"]).doUpdateSet({
              last_seen_at: newest.last_seen_at,
              schema_version: newest.schema_version,
              size_bytes: newest.size_bytes,
            }),
          ),
      );
      for (const alias of aliases) {
        if (alias.path !== stored) {
          executeSqliteQuerySync(
            db,
            queries
              .deleteFrom("agent_databases")
              .where("agent_id", "=", agentId)
              .where("path", "=", alias.path),
          );
        }
      }
      repaired += 1;
    }
  }
  return { repaired, warnings: [] };
}
