// Bounded media scans and source-drift evidence inside the Doctor migration owner's transaction.
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sql } from "kysely";
import type { TranscriptEvent } from "../config/sessions/session-accessor.sqlite-contract.js";
import { rewriteSqliteTranscriptEventRowsInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import { transcriptEventReadBytesSql } from "../config/sessions/session-transcript-read-bytes.js";
import { transcriptEventJsonSql } from "../config/sessions/transcript-payload.js";
import {
  canonicalizePersistedUserMessageMedia,
  hasMeaningfulRetiredMediaCarrier,
} from "../media/media-facts.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { readSqliteDataVersion } from "./node-sqlite.js";
import {
  eventIdentity,
  parseTranscriptEvent,
  transformTranscriptEvent,
} from "./state-migrations.media-persistence-transform.js";

const MEDIA_MIGRATION_ROW_BATCH_SIZE = 64;

type MediaMigrationDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "session_windows" | "trajectory_runtime_events" | "transcript_events"
>;

function forEachMediaEventBatch(params: {
  database: DatabaseSync;
  table: "trajectory_runtime_events" | "transcript_events";
  legacyTextStorage?: boolean;
  visit: (rows: Array<{ event_json: string; seq: number; session_id: string }>) => "stop" | void;
}): void {
  const db = getNodeSqliteKysely<MediaMigrationDatabase>(params.database);
  const eventJson =
    params.table === "transcript_events" && !params.legacyTextStorage
      ? transcriptEventJsonSql(params.database)
      : sql.ref<string>(`${params.table}.event_json`); // kysely-allow-raw: private TEXT-table union.
  let cursor: { seq: number; sessionId: string } | undefined;
  while (true) {
    let query = db
      .selectFrom(params.table)
      .select(["session_id", "seq"])
      .select(eventJson.as("event_json"))
      .orderBy("session_id", "asc")
      .orderBy("seq", "asc")
      .limit(MEDIA_MIGRATION_ROW_BATCH_SIZE);
    const after = cursor;
    if (after) {
      // Keep SQLite on a composite primary-key seek. Expanding this tuple into
      // OR branches restarts the index scan for every page.
      query = query.where((expression) =>
        expression(
          expression.refTuple("session_id", "seq"),
          ">",
          expression.tuple(after.sessionId, after.seq),
        ),
      );
    }
    const rows = executeSqliteQuerySync(params.database, query).rows;
    const last = rows.at(-1);
    if (!last) {
      return;
    }
    if (params.visit(rows) === "stop") {
      return;
    }
    cursor = { seq: last.seq, sessionId: last.session_id };
  }
}

export function scanTranscriptRows(params: {
  database: DatabaseSync;
  pathname: string;
  writer?: OpenClawAgentDatabase;
  legacyTextStorage: boolean;
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
    visit: (rows): "stop" | void => {
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
        if (eventIdentity(event) !== eventIdentity(transformed.event)) {
          throw new Error(`${owner} event identity changed during media migration`);
        }
        if (lastChangedSessionId !== row.session_id) {
          lastChangedSessionId = row.session_id;
          changedSessions += 1;
          params.onChangedSession?.(row.session_id);
        }
        // Detection only selects the repair path; that transaction validates every row.
        if (!writer) {
          return "stop";
        }
        const rewrites = rewritesBySession.get(row.session_id) ?? [];
        rewrites.push({
          event: transformed.event,
          expectedEventJson: row.event_json,
          seq: row.seq,
        });
        rewritesBySession.set(row.session_id, rewrites);
      }
      if (writer) {
        for (const [sessionId, rewrites] of rewritesBySession) {
          const sessionKey = sessionKeys.get(sessionId);
          if (!sessionKey) {
            throw new Error(
              `${pathname}:${sessionId} has transcript rows without a session window`,
            );
          }
          rewriteSqliteTranscriptEventRowsInTransaction(
            writer,
            { agentId: writer.agentId, path: pathname, sessionId, sessionKey },
            rewrites,
            { legacyTextStorage: params.legacyTextStorage },
          );
        }
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
  rewrite: boolean;
}): number {
  const { database, pathname, rewrite } = params;
  const db = getNodeSqliteKysely<MediaMigrationDatabase>(database);
  let changedRows = 0;
  forEachMediaEventBatch({
    database,
    table: "trajectory_runtime_events",
    visit: (rows): "stop" | void => {
      for (const row of rows) {
        const rewrittenEventJson = rewriteTrajectoryEventJson(
          row.event_json,
          `${pathname}:${row.session_id}:${row.seq}`,
        );
        if (rewrittenEventJson === row.event_json) {
          continue;
        }
        changedRows += 1;
        if (!rewrite) {
          return "stop";
        }
        executeSqliteQuerySync(
          database,
          db
            .updateTable("trajectory_runtime_events")
            .set({ event_json: rewrittenEventJson })
            .where("session_id", "=", row.session_id)
            .where("seq", "=", row.seq),
        );
      }
    },
  });
  return changedRows;
}

export function readMediaSourceVersion(database: DatabaseSync, legacyTextStorage: boolean) {
  const dataVersion = readSqliteDataVersion(database);
  const db = getNodeSqliteKysely<MediaMigrationDatabase>(database);
  const transcripts = db
    .selectFrom("transcript_events")
    .select((row) => [
      row.fn.countAll<number>().as("transcript_rows"),
      row.fn
        .coalesce(
          row.fn.sum<number>(
            legacyTextStorage
              ? row.fn<number>("octet_length", ["event_json"])
              : transcriptEventReadBytesSql(),
          ),
          row.val(0),
        )
        .as("transcript_bytes"),
      row
        .cast<string>(row.fn.coalesce(row.fn.sum<number>("created_at"), row.val(0)), "text")
        .as("transcript_created_at"),
    ])
    .as("transcripts");
  const trajectories = db
    .selectFrom("trajectory_runtime_events")
    .select((row) => [
      row.fn.countAll<number>().as("trajectory_rows"),
      row.fn
        .coalesce(row.fn.sum<number>(row.fn<number>("length", ["event_json"])), row.val(0))
        .as("trajectory_bytes"),
    ])
    .as("trajectories");
  const counts = executeSqliteQueryTakeFirstSync(
    database,
    db.selectFrom(transcripts).crossJoin(trajectories).selectAll(),
  );
  const number = (value: unknown): number =>
    typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : 0;
  const count = (key: keyof NonNullable<typeof counts>): number => number(counts?.[key]);
  return {
    dataVersion,
    trajectoryBytes: count("trajectory_bytes"),
    trajectoryRows: count("trajectory_rows"),
    transcriptBytes: count("transcript_bytes"),
    transcriptCreatedAt: counts?.transcript_created_at ?? "0",
    transcriptRows: count("transcript_rows"),
  };
}

type MediaSourceVersion = ReturnType<typeof readMediaSourceVersion>;

export function mediaSourceDriftMessage(
  pathname: string,
  expected: MediaSourceVersion,
  current: MediaSourceVersion,
): string {
  if (
    expected.transcriptRows !== current.transcriptRows ||
    expected.transcriptBytes !== current.transcriptBytes ||
    expected.transcriptCreatedAt !== current.transcriptCreatedAt
  ) {
    return `${pathname} transcript source changed before migration commit`;
  }
  if (
    expected.trajectoryRows !== current.trajectoryRows ||
    expected.trajectoryBytes !== current.trajectoryBytes
  ) {
    return `${pathname} trajectory source changed before migration commit`;
  }
  return `${pathname} source changed before migration transaction`;
}
