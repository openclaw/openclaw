import fs from "node:fs";
import path from "node:path";
import { requireNativeDatabaseFile } from "../infra/database-engine/physical-facts.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase, resolveImmutableSqliteFileUri } from "../infra/node-sqlite.js";
import { isPostgresSqlConnection } from "../infra/sql-connection.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { admitSqliteSchema } from "../infra/sqlite-schema-facts.js";
import { readMainTableList } from "../infra/sqlite-strict.js";
import { readActiveUpdateRun } from "../infra/update-run-read.kernel.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";
import { assertOpenClawStateDatabaseForMaintenance } from "./openclaw-state-db-maintenance.js";
import type { AgentDatabases, DB } from "./openclaw-state-db.generated.js";
import {
  resolveOpenClawAgentDatabaseStoredPath,
  resolveOpenClawRegisteredAgentDatabasePath,
} from "./openclaw-state-db.paths.js";

/** The caller retains shared-state write admission through this synchronous repair. */
export function repairOpenClawAgentDatabasePaths(
  database: Pick<OpenClawStateDatabase, "db" | "path">,
): { repaired: number; warnings: string[] } {
  const { db, path: pathname } = database;
  if (isPostgresSqlConnection(db)) {
    requireNativeDatabaseFile("postgres", "repair");
  }
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
  const agents = new Map<string, { stored: string; aliases: AgentDatabases[] }>();
  const warnings: string[] = [];
  let repaired = 0;
  for (const row of rows) {
    const stored = resolveOpenClawAgentDatabaseStoredPath(
      pathname,
      resolveOpenClawRegisteredAgentDatabasePath(pathname, row.path),
    );
    const key = `${row.agent_id}\0${stored}`;
    const group = agents.get(key) ?? { stored, aliases: [] };
    group.aliases.push(row);
    agents.set(key, group);
  }

  for (const { stored, aliases } of agents.values()) {
    const newest = aliases[0]!;
    const registeredPath = resolveOpenClawRegisteredAgentDatabasePath(pathname, newest.path);
    const name = path.basename(registeredPath).replace(/\.\d+(?=\.sqlite$)/, "");
    const sentinel =
      name === "(multiple).sqlite" || name === `(multiple).${newest.agent_id}.sqlite`;
    if (sentinel) {
      try {
        const files = resolveSqliteDatabaseFilePaths(registeredPath);
        const stats = files.map((file) => fs.lstatSync(file, { throwIfNoEntry: false }));
        if ([stats[1], stats[3]].some((stat) => stat?.size)) {
          throw new Error("database or sidecar needs inspection");
        }
        if (stats[0]?.size) {
          using source = openNodeSqliteDatabase(resolveImmutableSqliteFileUri(registeredPath), {
            readOnly: true,
          });
          admitSqliteSchema(source);
          const query = getNodeSqliteKysely<Record<string, Record<string, unknown>>>(source);
          // These tables contain ownership, policy, and index metadata, not user rows.
          const metadata = new Set(["schema_meta", "session_key_contract", "memory_index_state"]);
          for (const { type, name: table } of readMainTableList(source)) {
            if (type === "shadow" || metadata.has(table)) {
              continue;
            }
            const entry = query.selectFrom(table).selectAll().limit(1);
            if (executeSqliteQuerySync(source, entry).rows.length) {
              throw new Error("contains user rows");
            }
          }
        }
        for (const file of files) {
          fs.rmSync(file, { force: true });
        }
      } catch (error) {
        warnings.push(
          `Removed invalid agent database registration; kept ${registeredPath} for inspection (${String(error)}).`,
        );
      }
    } else {
      if (
        process.platform !== "win32" ||
        path.isAbsolute(stored) ||
        !aliases.some((row) => row.path.startsWith("\\\\?\\"))
      ) {
        continue;
      }
      const canonical = { ...newest, path: stored };
      executeSqliteQuerySync(
        db,
        queries
          .insertInto("agent_databases")
          .values(canonical)
          .onConflict((conflict) => conflict.columns(["agent_id", "path"]).doUpdateSet(canonical)),
      );
    }
    const obsolete = aliases
      .map((alias) => alias.path)
      .filter((alias) => sentinel || alias !== stored);
    executeSqliteQuerySync(
      db,
      queries
        .deleteFrom("agent_databases")
        .where("agent_id", "=", newest.agent_id)
        .where("path", "in", obsolete),
    );
    repaired += sentinel ? aliases.length : 1;
  }
  return { repaired, warnings };
}
