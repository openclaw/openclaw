import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { resolveLegacyPluginStateSqlitePath } from "../plugin-state/plugin-state-store.paths.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { normalizeSidecarNumber, removeSqliteSidecars } from "./doctor-sqlite-sidecar-shared.js";

type PluginStateEntriesTable = OpenClawStateKyselyDatabase["plugin_state_entries"];
type PluginStateRow = Selectable<PluginStateEntriesTable>;
type PluginStateDatabase = Pick<OpenClawStateKyselyDatabase, "plugin_state_entries">;

export type LegacyPluginStateSidecarImportResult = {
  sourcePath: string;
  importedEntries: number;
  removedSource: boolean;
};

function getPluginStateKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<PluginStateDatabase>(db);
}

function selectPluginStateRows(db: DatabaseSync): PluginStateRow[] {
  return executeSqliteQuerySync<PluginStateRow>(
    db,
    getPluginStateKysely(db)
      .selectFrom("plugin_state_entries")
      .select(["plugin_id", "namespace", "entry_key", "value_json", "created_at", "expires_at"])
      .orderBy("plugin_id", "asc")
      .orderBy("namespace", "asc")
      .orderBy("entry_key", "asc"),
  ).rows;
}

function upsertPluginStateRow(db: DatabaseSync, row: Insertable<PluginStateEntriesTable>): void {
  executeSqliteQuerySync(
    db,
    getPluginStateKysely(db)
      .insertInto("plugin_state_entries")
      .values(row)
      .onConflict((conflict) =>
        conflict.columns(["plugin_id", "namespace", "entry_key"]).doUpdateSet({
          value_json: (eb) => eb.ref("excluded.value_json"),
          created_at: (eb) => eb.ref("excluded.created_at"),
          expires_at: (eb) => eb.ref("excluded.expires_at"),
        }),
      ),
  );
}

export function legacyPluginStateSidecarExists(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(resolveLegacyPluginStateSqlitePath(env));
}

export function importLegacyPluginStateSidecarToSqlite(
  env: NodeJS.ProcessEnv = process.env,
): LegacyPluginStateSidecarImportResult {
  const sourcePath = resolveLegacyPluginStateSqlitePath(env);
  if (!existsSync(sourcePath)) {
    return {
      sourcePath,
      importedEntries: 0,
      removedSource: false,
    };
  }

  const { DatabaseSync } = requireNodeSqlite();
  const legacyDb = new DatabaseSync(sourcePath);
  let rows: PluginStateRow[];
  try {
    rows = selectPluginStateRows(legacyDb);
  } finally {
    legacyDb.close();
  }

  runOpenClawStateWriteTransaction(
    (database) => {
      for (const row of rows) {
        upsertPluginStateRow(database.db, {
          ...row,
          created_at: normalizeSidecarNumber(row.created_at) ?? 0,
          expires_at: normalizeSidecarNumber(row.expires_at) ?? null,
        });
      }
    },
    { env },
  );

  return {
    sourcePath,
    importedEntries: rows.length,
    removedSource: removeSqliteSidecars(sourcePath),
  };
}
