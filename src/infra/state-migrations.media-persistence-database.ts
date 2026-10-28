// Bounded media scans inside the Doctor migration owner's transaction.
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sql } from "kysely";
import type { TranscriptEvent } from "../config/sessions/session-accessor.sqlite-contract.js";
import { rewriteSqliteTranscriptEventRowsInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import { transcriptEventJsonSql } from "../config/sessions/transcript-payload.js";
import {
  canonicalizePersistedUserMessageMedia,
  hasMeaningfulRetiredMediaCarrier,
} from "../media/media-facts.js";
import { renewAgentDatabaseMaintenanceAuthorityIfPresent } from "../state/openclaw-agent-db-lease.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { prepareTrajectoryPayload, trajectoryEventJsonSql } from "../trajectory/runtime-payload.js";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "./kysely-sync.js";
import type { EngineConnection } from "./sql-connection.js";
import {
  parseTranscriptEvent,
  transformTranscriptEvent,
} from "./state-migrations.media-persistence-transform.js";

const MEDIA_MIGRATION_ROW_BATCH_SIZE = 64;
const MEDIA_MIGRATION_BATCH_BYTES = 4 * 1024 * 1024;

type MediaMigrationDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "session_windows" | "trajectory_runtime_events" | "transcript_events"
>;

function forEachMediaEventBatch(params: {
  database: EngineConnection;
  table: "trajectory_runtime_events" | "transcript_events";
  legacyTextStorage: boolean;
  visit: (rows: Array<{ event_json: string; seq: number; session_id: string }>) => boolean | void;
}): void {
  const db = getNodeSqliteKysely<MediaMigrationDatabase>(params.database);
  const eventJson = params.legacyTextStorage
    ? sql.ref<string>(`${params.table}.event_json`) // kysely-allow-raw: private historical TEXT-table union.
    : params.table === "transcript_events"
      ? transcriptEventJsonSql(params.database)
      : trajectoryEventJsonSql(params.database);
  const query = db
    .selectFrom(params.table)
    .select(["session_id", "seq"])
    .select(eventJson.as("event_json"))
    .orderBy("session_id", "asc")
    .orderBy("seq", "asc");
  let rows: Array<{ event_json: string; seq: number; session_id: string }> = [];
  let bytes = 0;
  let renewedAt = performance.now();
  // Rewrites preserve the scan's primary key. Retain at most a byte-bounded
  // batch plus one incoming row; a giant historical row is processed alone.
  for (const row of iterateSqliteQuerySync(params.database, query)) {
    if (performance.now() - renewedAt >= 1_000) {
      renewAgentDatabaseMaintenanceAuthorityIfPresent();
      renewedAt = performance.now();
    }
    const rowBytes = Buffer.byteLength(row.event_json);
    if (rows.length > 0 && bytes + rowBytes > MEDIA_MIGRATION_BATCH_BYTES) {
      if (params.visit(rows) === false) {
        return;
      }
      rows = [];
      bytes = 0;
    }
    rows.push(row);
    bytes += rowBytes;
    if (rows.length >= MEDIA_MIGRATION_ROW_BATCH_SIZE || bytes >= MEDIA_MIGRATION_BATCH_BYTES) {
      if (params.visit(rows) === false) {
        return;
      }
      rows = [];
      bytes = 0;
    }
  }
  if (rows.length > 0) {
    params.visit(rows);
  }
}

export function mediaRowsNeedMigration(database: EngineConnection, pathname: string): boolean {
  for (const table of ["transcript_events", "trajectory_runtime_events"] as const) {
    let changed = false;
    forEachMediaEventBatch({
      database,
      table,
      legacyTextStorage: false,
      visit: (rows) => {
        changed = rows.some((row) => {
          const owner = `${pathname}:${row.session_id}:${row.seq}`;
          return table === "transcript_events"
            ? transformTranscriptEvent(parseTranscriptEvent(row.event_json, owner)).changed
            : rewriteTrajectoryEventJson(row.event_json, owner) !== row.event_json;
        });
        return !changed;
      },
    });
    if (changed) {
      return true;
    }
  }
  return false;
}

export function scanTranscriptRows(params: {
  database: DatabaseSync;
  pathname: string;
  writer: OpenClawAgentDatabase;
  legacyTextStorage: boolean;
  beforeRewrite: () => void;
  onChangedSession?: (sessionId: string) => void;
}): number {
  const { database, pathname, writer } = params;
  const db = getNodeSqliteKysely<MediaMigrationDatabase>(database);
  let lastChangedSessionId: string | undefined;
  let changedSessions = 0;
  forEachMediaEventBatch({
    database,
    table: "transcript_events",
    legacyTextStorage: params.legacyTextStorage,
    visit: (rows) => {
      const sessionIds = [...new Set(rows.map((row) => row.session_id))];
      const sessionKeys = new Map(
        executeSqliteQuerySync(
          database,
          db
            .selectFrom("session_windows")
            .select(["session_id", "session_key"])
            .where("session_id", "in", sessionIds),
        ).rows.map((row) => [row.session_id, row.session_key]),
      );
      for (const sessionId of sessionIds) {
        if (!sessionKeys.has(sessionId)) {
          throw new Error(`${pathname}:${sessionId} has transcript rows without a session window`);
        }
      }
      const rewritesBySession = new Map<
        string,
        Array<{ event: TranscriptEvent; expectedEventJson: string; seq: number }>
      >();
      for (const row of rows) {
        const owner = `${pathname}:${row.session_id}:${row.seq}`;
        const event = parseTranscriptEvent(row.event_json, owner);
        const transformed = transformTranscriptEvent(event);
        if (!transformed.changed) {
          continue;
        }
        if (lastChangedSessionId !== row.session_id) {
          lastChangedSessionId = row.session_id;
          changedSessions += 1;
          params.onChangedSession?.(row.session_id);
        }
        const rewrites = rewritesBySession.get(row.session_id) ?? [];
        rewrites.push({
          event: transformed.event,
          expectedEventJson: row.event_json,
          seq: row.seq,
        });
        rewritesBySession.set(row.session_id, rewrites);
      }
      for (const [sessionId, rewrites] of rewritesBySession) {
        const sessionKey = sessionKeys.get(sessionId);
        if (!sessionKey) {
          throw new Error(`${pathname}:${sessionId} has transcript rows without a session window`);
        }
        params.beforeRewrite();
        rewriteSqliteTranscriptEventRowsInTransaction(
          writer,
          { agentId: writer.agentId, path: pathname, sessionId, sessionKey },
          rewrites,
          { legacyTextStorage: params.legacyTextStorage },
        );
      }
    },
  });
  return changedSessions;
}

function rewriteTrajectoryEventJson(eventJson: string, owner: string): string {
  let event: unknown;
  try {
    event = JSON.parse(eventJson);
  } catch (error) {
    throw new Error(`${owner} contains invalid trajectory JSON: ${String(error)}`, {
      cause: error,
    });
  }
  if (!isRecord(event) || !isRecord(event.data) || !Array.isArray(event.data.messagesSnapshot)) {
    return eventJson;
  }
  let changed = false;
  const messagesSnapshot = event.data.messagesSnapshot.map((message) => {
    if (!isRecord(message) || !hasMeaningfulRetiredMediaCarrier(message)) {
      return message;
    }
    const canonical = canonicalizePersistedUserMessageMedia(message);
    changed ||= canonical.changed;
    return canonical.message;
  });
  return changed
    ? JSON.stringify({ ...event, data: { ...event.data, messagesSnapshot } })
    : eventJson;
}

export function scanTrajectoryRows(params: {
  database: DatabaseSync;
  pathname: string;
  legacyTextStorage: boolean;
  beforeRewrite: () => void;
}): number {
  const { database, pathname } = params;
  const db = getNodeSqliteKysely<MediaMigrationDatabase>(database);
  let changedRows = 0;
  forEachMediaEventBatch({
    database,
    table: "trajectory_runtime_events",
    legacyTextStorage: params.legacyTextStorage,
    visit: (rows) => {
      for (const row of rows) {
        const rewrittenEventJson = rewriteTrajectoryEventJson(
          row.event_json,
          `${pathname}:${row.session_id}:${row.seq}`,
        );
        if (rewrittenEventJson === row.event_json) {
          continue;
        }
        changedRows += 1;
        params.beforeRewrite();
        executeSqliteQuerySync(
          database,
          db
            .updateTable("trajectory_runtime_events")
            .set(
              params.legacyTextStorage
                ? { event_json: rewrittenEventJson }
                : prepareTrajectoryPayload(database, rewrittenEventJson),
            )
            .where("session_id", "=", row.session_id)
            .where("seq", "=", row.seq),
        );
      }
    },
  });
  return changedRows;
}
