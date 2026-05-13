import { randomUUID } from "node:crypto";
import type { Insertable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../../state/openclaw-state-db.js";

type CommandLogDatabase = Pick<OpenClawStateKyselyDatabase, "command_log_entries">;

export type CommandLogEntryInput = {
  timestamp: Date;
  action: string;
  sessionKey: string;
  senderId: string;
  source: string;
};

export function recordCommandLogEntry(
  entry: CommandLogEntryInput,
  options?: OpenClawStateDatabaseOptions,
): void {
  const timestampMs = entry.timestamp.getTime();
  const row: Insertable<CommandLogDatabase["command_log_entries"]> = {
    id: randomUUID(),
    timestamp_ms: Number.isFinite(timestampMs) ? timestampMs : Date.now(),
    action: entry.action,
    session_key: entry.sessionKey,
    sender_id: entry.senderId,
    source: entry.source,
    entry_json: JSON.stringify({
      timestamp: entry.timestamp.toISOString(),
      action: entry.action,
      sessionKey: entry.sessionKey,
      senderId: entry.senderId,
      source: entry.source,
    }),
  };

  runOpenClawStateWriteTransaction((database) => {
    executeSqliteQuerySync(
      database.db,
      getNodeSqliteKysely<CommandLogDatabase>(database.db)
        .insertInto("command_log_entries")
        .values(row),
    );
  }, options);
}
