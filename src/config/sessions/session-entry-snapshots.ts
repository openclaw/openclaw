import { expressionBuilder } from "kysely";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type { SessionEntrySnapshotRow } from "./session-entry-storage.types.js";
import type { SessionEntry } from "./types.js";

export type SessionEntrySnapshot = {
  field: (typeof snapshotColumns)[number][0];
  valueJson: string;
};

export type SessionEntrySnapshotField = SessionEntrySnapshot["field"];
export type SessionEntryProjection = "full" | "list" | readonly SessionEntrySnapshotField[];

export type { SessionEntrySnapshotRow } from "./session-entry-storage.types.js";

const snapshotColumns = [
  ["sessionDiffBaseline", "session_diff_baseline_json"],
  ["skillsSnapshot", "skills_snapshot_json"],
  ["systemPromptReport", "system_prompt_report_json"],
] as const;

/** One statement owns hot and cold facts; JSON remains opaque to SQLite's depth limit. */
export function sessionEntrySnapshotColumnsForKeys(
  keys?: readonly string[],
  projection: SessionEntryProjection = "full",
) {
  const selectedKeys = keys === undefined ? undefined : sqliteStringSet(keys);
  const eb = expressionBuilder<DB, "session_nodes">();
  return snapshotColumns
    .filter(
      ([field]) => projection === "full" || (projection !== "list" && projection.includes(field)),
    )
    .map(([field, alias]) => {
      const snapshot = eb
        .selectFrom("session_entry_snapshots")
        .select("value_json")
        .whereRef("session_entry_snapshots.session_key", "=", "session_nodes.session_key")
        .where("field", "=", field);
      return (
        selectedKeys === undefined
          ? snapshot
          : eb.case().when("session_nodes.session_key", "in", selectedKeys).then(snapshot).end()
      ).as(alias);
    });
}

export const sessionEntrySnapshotColumns = sessionEntrySnapshotColumnsForKeys();

export function splitSessionEntrySnapshots(
  entry: SessionEntry | Record<string, unknown>,
  mode: "complete" | { previousEntry: SessionEntry | undefined } = "complete",
): {
  entryJson: string;
  snapshots: SessionEntrySnapshot[];
  snapshotsChanged: boolean;
} {
  const { sessionDiffBaseline, skillsSnapshot, systemPromptReport, ...hot } = entry;
  const values = { sessionDiffBaseline, skillsSnapshot, systemPromptReport };
  const snapshotsChanged =
    mode === "complete" ||
    snapshotColumns.some(([field]) => values[field] !== mode.previousEntry?.[field]);
  const snapshots: SessionEntrySnapshot[] = [];
  for (const [field] of snapshotsChanged ? snapshotColumns : []) {
    const valueJson = JSON.stringify(values[field]);
    if (valueJson !== undefined) {
      snapshots.push({ field, valueJson });
    }
  }
  return { entryJson: JSON.stringify(hot), snapshots, snapshotsChanged };
}

export function attachSessionEntrySnapshots<T extends object>(
  entry: T,
  row: SessionEntrySnapshotRow,
  projection: SessionEntryProjection = "full",
): T {
  for (const [field, alias] of snapshotColumns) {
    if (projection !== "full" && (projection === "list" || !projection.includes(field))) {
      // Pending legacy rows may still carry snapshots inline.
      Reflect.deleteProperty(entry, field);
      continue;
    }
    const valueJson = row[alias];
    if (valueJson != null) {
      const value: unknown = JSON.parse(valueJson);
      Object.assign(entry, { [field]: value });
    }
  }
  return entry;
}

/** The entry writer owns this synchronous transaction and publishes its committed facts. */
export function writeSessionEntrySnapshots(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionKey: string,
  snapshots: readonly SessionEntrySnapshot[],
): void {
  if (!database.db.isTransaction) {
    throw new Error("Session snapshot writes require an entry transaction");
  }
  const db = getNodeSqliteKysely<DB>(database.db);
  executeSqliteQuerySync(
    database.db,
    db
      .deleteFrom("session_entry_snapshots")
      .where("session_key", "=", sessionKey)
      .$if(snapshots.length > 0, (query) =>
        query.where(
          "field",
          "not in",
          snapshots.map((snapshot) => snapshot.field),
        ),
      ),
  );
  if (snapshots.length > 0) {
    executeSqliteQuerySync(
      database.db,
      db
        .insertInto("session_entry_snapshots")
        .values(
          snapshots.map((snapshot) => ({
            session_key: sessionKey,
            field: snapshot.field,
            value_json: snapshot.valueJson,
          })),
        )
        .onConflict((conflict) =>
          conflict
            .columns(["session_key", "field"])
            .doUpdateSet((eb) => ({ value_json: eb.ref("excluded.value_json") }))
            .whereRef("session_entry_snapshots.value_json", "!=", "excluded.value_json"),
        ),
    );
  }
}
