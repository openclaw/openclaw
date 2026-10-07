import { randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { resolveStateDir } from "../config/paths.js";
import { formatErrorMessage } from "../infra/errors.js";
import { writeTextAtomic } from "../infra/json-files.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { isSqliteCorruptionError } from "../infra/sqlite-error-diagnostics.js";
import { SQLITE_SIDECAR_SUFFIXES } from "../infra/sqlite-files.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { hasSqliteFileFamily } from "../state/agent-deletion-discovery.js";
import {
  reconstructAgentDeletionJournal,
  recordAgentDeletionRecoveryHolds,
} from "../state/agent-deletion-journal-recovery.js";
import { readAgentDeletionRecoveryHolds } from "../state/agent-deletion-journal-recovery.kernel.js";
import {
  parseCleanupPaths,
  readAgentDeletionJournalInDatabase,
} from "../state/agent-deletion-journal.js";
import { parseAgentDeletionDatabasePaths } from "../state/agent-deletion-journal.read.js";
import type { HeldAgentDatabase } from "../state/agent-deletion-journal.types.js";
import { resolveOpenClawAgentDatabaseDiscoveryPaths } from "../state/openclaw-agent-db-discovery-paths.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { isReservedSystemAgentId } from "../system-agent/agent-id.js";

type JournalDatabase = Pick<OpenClawStateDatabase, "db" | "path">;

function readRecoverySource(database: JournalDatabase) {
  const held = tableExists(database.db, "migration_sources")
    ? readAgentDeletionRecoveryHolds(database)
    : [];
  if (!tableExists(database.db, "agent_deletion_journal")) {
    return { missing: true, rows: [], invalid: [], held };
  }
  const rows = executeSqliteQuerySync(
    database.db,
    getNodeSqliteKysely<Pick<DB, "agent_deletion_journal">>(database.db)
      .selectFrom("agent_deletion_journal")
      .selectAll()
      .orderBy("agent_id"),
  ).rows;
  const invalid = rows.filter((row) => {
    if (isReservedSystemAgentId(row.agent_id)) {
      return true;
    }
    try {
      readAgentDeletionJournalInDatabase(database, row.agent_id);
      return false;
    } catch (error) {
      if (isSqliteCorruptionError(error)) {
        throw error;
      }
      // The raw row remains the recovery source; parsing cannot grant cleanup authority.
      return true;
    }
  });
  return { missing: false, rows, invalid, held };
}

/** Doctor preserves unusable journal rows before trading cleanup authority for repair holds. */
export async function quarantineAgentDeletionJournal(params: {
  inventory: readonly HeldAgentDatabase[];
  env: NodeJS.ProcessEnv;
}): Promise<{ held: HeldAgentDatabase[]; archives: string[]; warnings: string[] } | undefined> {
  const { env } = params;
  const source = withExistingOpenClawStateDatabaseReadOnly(readRecoverySource, { env }) ?? {
    missing: true,
    rows: [],
    invalid: [],
    held: [],
  };
  if (!source.missing && source.invalid.length === 0) {
    return undefined;
  }
  const held = source.missing ? [...params.inventory] : [...source.held];
  for (const row of source.invalid) {
    const paths = new Set([
      ...resolveOpenClawAgentDatabaseDiscoveryPaths({
        agentDir: row.agent_dir,
        agentId: row.agent_id,
        env,
      }).filter(hasSqliteFileFamily),
      ...params.inventory
        .filter((target) => normalizeAgentId(target.agentId) === normalizeAgentId(row.agent_id))
        .map((target) => target.path),
    ]);
    try {
      for (const pathname of parseAgentDeletionDatabasePaths(row.database_paths_json)) {
        paths.add(pathname);
      }
    } catch {
      // One damaged JSON field must not erase independently readable paths.
    }
    try {
      for (const cleanup of parseCleanupPaths(row.cleanup_paths_json)) {
        for (const pathname of cleanup.sourcePaths) {
          paths.add(pathname);
        }
      }
    } catch {
      // The exact malformed field is retained in the archive below.
    }
    held.push(
      ...[...paths]
        .filter(
          (pathname) =>
            !SQLITE_SIDECAR_SUFFIXES.some(
              (suffix) => pathname.endsWith(suffix) && paths.has(pathname.slice(0, -suffix.length)),
            ),
        )
        .map((pathname) => ({ agentId: row.agent_id, path: pathname })),
    );
  }
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  const assertCurrent = () => maintenance?.assertAdmission();
  const archives: string[] = [];
  const warnings: string[] = [];
  const agentIds = new Set(held.map((target) => normalizeAgentId(target.agentId)));
  for (const agentId of agentIds) {
    const archive = path.join(
      resolveStateDir(env),
      "agents",
      agentId,
      "recovery",
      `deletion-journal-${randomUUID()}.json`,
    );
    assertCurrent();
    try {
      await writeTextAtomic(
        archive,
        JSON.stringify(
          {
            source: resolveOpenClawStateSqlitePath(env),
            reason: source.missing ? "missing deletion journal" : "unusable deletion journal",
            journal: source.invalid.filter((row) => normalizeAgentId(row.agent_id) === agentId),
            held: held.filter((target) => normalizeAgentId(target.agentId) === agentId),
          },
          null,
          2,
        ),
        {
          mode: 0o600,
          dirMode: 0o700,
          durable: true,
          beforeRename: async () => {
            assertCurrent();
          },
        },
      );
      archives.push(archive);
    } catch (error) {
      warnings.push(
        `Warning: Could not save deletion recovery receipt ${archive}: ${formatErrorMessage(error)}. Original journal records remain in place and stores remain held; repair the recovery directory, then run openclaw doctor --fix.`,
      );
    }
  }
  assertCurrent();
  if (warnings.length > 0) {
    // Retained malformed rows still fence maintenance globally; preserve those stores too.
    held.push(...params.inventory);
  }
  const remaining = runOpenClawStateWriteTransaction(
    (database) => {
      assertCurrent();
      if (!isDeepStrictEqual(readRecoverySource(database), source)) {
        throw new Error(
          "Agent deletion journal changed before quarantine; stores were left untouched.",
        );
      }
      if (source.missing) {
        return reconstructAgentDeletionJournal(database, held);
      }
      const query = getNodeSqliteKysely<Pick<DB, "agent_deletion_journal">>(database.db);
      for (const row of warnings.length === 0 ? source.invalid : []) {
        if (isReservedSystemAgentId(row.agent_id)) {
          executeSqliteQuerySync(
            database.db,
            query.deleteFrom("agent_deletion_journal").where("agent_id", "=", row.agent_id),
          );
          continue;
        }
        executeSqliteQuerySync(
          database.db,
          query
            .updateTable("agent_deletion_journal")
            .set({
              operation_id: randomUUID(),
              database_paths_json: JSON.stringify([
                ...new Set(
                  held
                    .filter(
                      (target) =>
                        normalizeAgentId(target.agentId) === normalizeAgentId(row.agent_id),
                    )
                    .map((target) => target.path),
                ),
              ]),
              cleanup_paths_json: "[]",
              // A maintenance hold alone cannot retain the runtime deletion fence.
              cleanup_completed: 1,
              delete_files: 0,
            })
            .where("agent_id", "=", row.agent_id),
        );
      }
      return recordAgentDeletionRecoveryHolds(database, held, {
        description:
          warnings.length === 0
            ? "Quarantined unusable agent deletion records; stores remain held for explicit recovery."
            : "Preserved unusable agent deletion records in place; stores remain held for explicit recovery.",
      });
    },
    { env },
  );
  return { held: remaining, archives, warnings };
}
