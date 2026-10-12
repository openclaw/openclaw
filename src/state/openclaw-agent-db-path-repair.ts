import fs from "node:fs";
import path from "node:path";
import { resolveConfiguredAgentDatabaseTargets } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { createVerifiedSqliteSnapshot } from "../infra/sqlite-snapshot.js";
import { readActiveUpdateRun } from "../infra/update-run-read.kernel.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db-maintenance-lease.js";
import { readExistingAgentSchemaMeta } from "./openclaw-agent-db-metadata.js";
import { isSameOpenClawAgentDatabasePath } from "./openclaw-agent-db.paths.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";
import { assertOpenClawStateDatabaseForMaintenance } from "./openclaw-state-db-maintenance.js";
import type { AgentDatabases, DB } from "./openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import {
  resolveOpenClawAgentDatabaseStoredPath,
  resolveOpenClawRegisteredAgentDatabasePath,
  resolveOpenClawStateDirForDatabasePath,
} from "./openclaw-state-db.paths.js";

export type AgentDatabasePathRepairReport = {
  repaired: number;
  warnings: string[];
  hasSentinelPaths?: boolean;
  backupDirectory?: string;
};

/** Repair only empty, unconfigured files created from the old aggregate store label. */
export async function repairOpenClawSentinelAgentDatabasePaths(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Promise<AgentDatabasePathRepairReport> {
  return withAgentDatabaseMaintenanceLease({ env }, async (maintenance) => {
    const database = openOpenClawStateDatabase({ env });
    const active = readActiveUpdateRun(database.db);
    if (active) {
      return {
        repaired: 0,
        warnings: [
          `Skipped agent database path repair while update ${active.runId} is in progress. Run openclaw doctor --fix after the update finishes.`,
        ],
      };
    }
    const queries = getNodeSqliteKysely<Pick<DB, "agent_databases">>(database.db);
    const configured = resolveConfiguredAgentDatabaseTargets(cfg, { env });
    const root = resolveOpenClawStateDirForDatabasePath(database.path);
    const rows = executeSqliteQuerySync(
      database.db,
      queries.selectFrom("agent_databases").selectAll(),
    ).rows;
    const candidates = rows.flatMap((row) => {
      const filename = resolveOpenClawRegisteredAgentDatabasePath(database.path, row.path);
      return path.dirname(filename) === root &&
        /^\(multiple\)(?:\.[a-z0-9_-]+(?:\.[1-9]\d*)?)?\.sqlite$/u.test(path.basename(filename)) &&
        !configured.some((target) => isSameOpenClawAgentDatabasePath(target.path, filename))
        ? [{ row, filename }]
        : [];
    });
    const report: AgentDatabasePathRepairReport = { repaired: 0, warnings: [] };
    if (candidates.length === 0) {
      return report;
    }
    const backupDir = fs.mkdtempSync(path.join(root, "agent-database-path-repair-"));
    await createVerifiedSqliteSnapshot({
      sourcePath: database.path,
      targetPath: path.join(backupDir, "openclaw.sqlite"),
      beforePublish: () => maintenance.assertOwned(),
    });
    report.backupDirectory = backupDir;
    for (const { row, filename } of candidates) {
      try {
        maintenance.assertOwned();
        const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
        if (stat) {
          if (!stat.isFile() || stat.nlink !== 1) {
            throw new Error("not an unaliased regular file");
          }
          await createVerifiedSqliteSnapshot({
            sourcePath: filename,
            targetPath: path.join(backupDir, path.basename(filename)),
            validate: (db, name) => assertEmptySentinelDatabase(db, name, row.agent_id),
            beforePublish: () => maintenance.assertOwned(),
          });
          const inspected = openNodeSqliteDatabase(filename, { readOnly: true });
          try {
            assertEmptySentinelDatabase(inspected, filename, row.agent_id);
          } finally {
            inspected.close();
          }
        }
        maintenance.assertOwned();
        runOpenClawStateWriteTransaction(
          (state) => {
            maintenance.assertOwnedInTransaction(state.db);
            if (readActiveUpdateRun(state.db)) {
              throw new Error("an update started during agent database path repair");
            }
            if (stat) {
              for (const suffix of ["-wal", "-shm", "-journal", ""]) {
                fs.rmSync(`${filename}${suffix}`, { force: true });
              }
            }
            executeSqliteQuerySync(
              state.db,
              queries
                .deleteFrom("agent_databases")
                .where("agent_id", "=", row.agent_id)
                .where("path", "=", row.path),
            );
          },
          { env },
        );
        report.repaired += 1;
      } catch (error) {
        report.warnings.push(
          `Could not finish agent database path repair for ${filename}: ${formatErrorMessage(error)}. Backup: ${backupDir}`,
        );
      }
    }
    return report;
  });
}

function assertEmptySentinelDatabase(
  database: import("node:sqlite").DatabaseSync,
  pathname: string,
  agentId: string,
): void {
  assertSqliteIntegrity(database, pathname);
  const meta = readExistingAgentSchemaMeta(database);
  if (
    meta?.role !== "agent" ||
    meta.agentId !== agentId ||
    meta.schemaVersion === null ||
    meta.schemaVersion > OPENCLAW_AGENT_SCHEMA_VERSION
  ) {
    throw new Error("unrecognized agent database metadata; manual recovery required");
  }
  // Shadow tables contain SQLite's own FTS bookkeeping even in an unused database.
  const tables = database // sqlite-allow-raw -- Enumerate historical tables outside the current generated schema.
    .prepare(
      "SELECT name FROM pragma_table_list WHERE schema = 'main' AND type IN ('table', 'virtual') AND name NOT LIKE 'sqlite_%'",
    )
    .all();
  for (const { name } of tables) {
    if (typeof name !== "string" || name === "schema_meta" || name === "session_key_contract") {
      continue;
    }
    const condition = name === "memory_index_state" ? " WHERE id != 1 OR revision != 0" : "";
    if (
      // sqlite-allow-raw -- Check quoted historical table identifiers for retained data before removal.
      database.prepare(`SELECT 1 FROM "${name.replaceAll('"', '""')}"${condition} LIMIT 1`).get()
    ) {
      throw new Error(`contains retained data in ${name}; manual recovery required`);
    }
  }
}

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
      if (process.platform !== "win32" || !aliases.some((row) => row.path.startsWith("\\\\?\\"))) {
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
  return {
    repaired,
    warnings: [],
    hasSentinelPaths: rows.some((row) => path.basename(row.path).startsWith("(multiple)")),
  };
}
