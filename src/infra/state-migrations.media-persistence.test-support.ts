import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import { cleanupTempDirs } from "../../test/helpers/temp-dir.js";
import {
  encodeSessionArchiveContent,
  SESSION_ARCHIVE_ZSTD_SUFFIX,
} from "../config/sessions/archive-compression.js";
import { reconcileSessionTranscriptIndexInTransaction } from "../config/sessions/session-transcript-index.js";
import { prepareMemorySessionTranscriptProjection } from "../config/sessions/session-transcript-projection-rebuild.js";
import { transcriptEventJsonSql } from "../config/sessions/transcript-payload.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { removeCanonicalValidationFromHistoricalAgentFixture } from "../state/openclaw-agent-db.test-support.js";
import { seedOpenClawAgentSchemaV21 } from "../state/openclaw-agent-schema-v21.test-support.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { requireNodeSqlite } from "./node-sqlite.js";

export const PREVIOUS_VERSION = 16;

export type FixtureEvent = Record<string, unknown>;

export function createEvent(params: {
  id: string;
  message: Record<string, unknown>;
  parentId: string | null;
  timestamp: number;
}): FixtureEvent {
  return {
    type: "message",
    id: params.id,
    parentId: params.parentId,
    timestamp: params.timestamp,
    message: params.message,
  };
}

export function createLegacyDatabaseFixture(params: {
  agentId?: string;
  env: NodeJS.ProcessEnv;
  eventsBySession: Record<string, FixtureEvent[]>;
  path?: string;
  schemaVersion?: number;
}): string {
  const agentId = params.agentId ?? "main";
  const schemaVersion = params.schemaVersion ?? PREVIOUS_VERSION;
  const legacy = schemaVersion < OPENCLAW_AGENT_SCHEMA_VERSION;
  const options = { agentId, env: params.env, path: params.path };
  const databasePath = legacy
    ? resolveOpenClawAgentSqlitePath(options)
    : openOpenClawAgentDatabase(options).path;
  closeOpenClawAgentDatabasesForTest();
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  try {
    if (legacy) {
      seedOpenClawAgentSchemaV21(database, agentId);
    }
    database.exec("PRAGMA foreign_keys = ON;");
    if (schemaVersion < 21) {
      removeCanonicalValidationFromHistoricalAgentFixture(database);
    }
    if (schemaVersion < 18) {
      database.exec("DROP TABLE session_participants;");
    }
    database.exec(`PRAGMA user_version = ${schemaVersion};`);
    database
      .prepare(
        "UPDATE schema_meta SET schema_version = ?, app_version = ? WHERE meta_key = 'primary'",
      )
      .run(schemaVersion, "legacy-test");
    for (const [sessionId, events] of Object.entries(params.eventsBySession)) {
      const sessionKey = `agent:${agentId}:${sessionId}`;
      const firstTimestamp = Number(events[0]?.timestamp ?? 1);
      database
        .prepare(
          "INSERT INTO session_nodes(session_key,current_session_id,entry_json,updated_at) VALUES(?,?,?,?)",
        )
        .run(sessionKey, sessionId, "{}", firstTimestamp);
      database
        .prepare(
          "INSERT INTO session_windows(session_id,session_key,created_at,updated_at) VALUES(?,?,?,?)",
        )
        .run(sessionId, sessionKey, firstTimestamp, firstTimestamp);
      database
        .prepare(
          "INSERT INTO transcript_rewrite_watermarks(session_id,generation,updated_at) VALUES(?,?,?)",
        )
        .run(sessionId, `generation-${sessionId}`, firstTimestamp);
      events.forEach((event, seq) => {
        const createdAt = Number(event.timestamp ?? firstTimestamp) + 100;
        database
          .prepare(
            "INSERT INTO transcript_events(session_id,seq,event_json,created_at) VALUES(?,?,?,?)",
          )
          .run(sessionId, seq, JSON.stringify(event), createdAt);
        database
          .prepare(
            "INSERT INTO transcript_event_identities(session_id,event_id,seq,event_type,parent_id,message_idempotency_key,created_at) VALUES(?,?,?,?,?,?,?)",
          )
          .run(
            sessionId,
            String(event.id),
            seq,
            String(event.type),
            typeof event.parentId === "string" ? event.parentId : null,
            (event.message as { idempotencyKey?: string }).idempotencyKey ?? null,
            createdAt,
          );
      });
      if (legacy) {
        seedHistoricalTranscriptProjection(database, sessionId, events);
      } else {
        reconcileSessionTranscriptIndexInTransaction(database, sessionId);
      }
    }
  } finally {
    database.close();
  }
  registerOpenClawAgentDatabase({
    agentId,
    env: params.env,
    path: databasePath,
    schemaVersion,
  });
  return databasePath;
}

function seedHistoricalTranscriptProjection(
  database: DatabaseSync,
  sessionId: string,
  events: readonly FixtureEvent[],
): void {
  const firstTimestamp = Number(events[0]?.timestamp ?? 1);
  const plan = prepareMemorySessionTranscriptProjection(
    sessionId,
    null,
    new Map(
      events.map((event, seq) => [
        seq,
        {
          seq,
          event_json: JSON.stringify(event),
          created_at: Number(event.timestamp ?? firstTimestamp) + 100,
        },
      ]),
    ),
    `generation-${sessionId}`,
  );
  if (!plan) {
    return;
  }
  const active = database.prepare(`INSERT INTO session_transcript_active_events
    (session_id,active_position,event_seq,message_position,context_eligible) VALUES(?,?,?,?,?)`);
  for (const row of plan.activeRows) {
    active.run(
      sessionId,
      row.activePosition,
      row.eventSeq,
      row.messagePosition,
      row.contextEligible,
    );
  }
  const fts = database.prepare(`INSERT INTO session_transcript_fts
    (text,session_id,message_id,role,timestamp) VALUES(?,?,?,?,?)`);
  for (const row of plan.ftsRows) {
    fts.run(row.text, sessionId, row.messageId, row.role, row.timestamp);
  }
  database
    .prepare(`INSERT INTO session_transcript_index_state
    (session_id,indexed_seq,leaf_event_id,needs_rebuild,active_event_count,active_message_count,updated_at)
    VALUES(?,?,?,0,?,?,?)`)
    .run(
      sessionId,
      plan.sourceIndexedSeq,
      plan.leafEventId,
      plan.activeEventCount,
      plan.activeMessageCount,
      firstTimestamp,
    );
}

export function readDatabaseSnapshot(databasePath: string) {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  try {
    const version = database.prepare("PRAGMA user_version").get() as { user_version: number };
    const rows = executeSqliteQuerySync(
      database,
      getNodeSqliteKysely<Pick<DB, "transcript_events">>(database)
        .selectFrom("transcript_events")
        .select(["session_id", "seq", "created_at"])
        .select(
          (version.user_version < 22
            ? sql.ref<string>("transcript_events.event_json") // kysely-allow-raw: frozen pre22 TEXT NOT NULL.
            : transcriptEventJsonSql(database)
          ).as("event_json"),
        )
        .orderBy("session_id")
        .orderBy("seq"),
    ).rows;
    const identities = database
      .prepare(
        "SELECT session_id,event_id,seq,event_type,parent_id,message_idempotency_key,created_at FROM transcript_event_identities ORDER BY session_id,seq",
      )
      .all();
    const activeBranch = database
      .prepare(
        "SELECT session_id,active_position,event_seq,message_position FROM session_transcript_active_events ORDER BY session_id,active_position",
      )
      .all();
    const windows = database
      .prepare(
        "SELECT session_id,session_key,created_at,updated_at,transcript_observed_at FROM session_windows ORDER BY session_id",
      )
      .all();
    const generations = database
      .prepare(
        "SELECT session_id,generation FROM transcript_rewrite_watermarks ORDER BY session_id",
      )
      .all();
    const trajectoryCount = database
      .prepare("SELECT count(*) AS count FROM trajectory_runtime_events")
      .get() as { count: number };
    const trajectoryRows = database
      .prepare(
        "SELECT session_id,seq,run_id,event_json,created_at FROM trajectory_runtime_events ORDER BY session_id,seq",
      )
      .all() as Array<{
      session_id: string;
      seq: number;
      run_id: string | null;
      event_json: string;
      created_at: number;
    }>;
    return {
      activeBranch,
      generations,
      identities,
      rows,
      trajectoryCount: trajectoryCount.count,
      trajectoryRows,
      version,
      windows,
    };
  } finally {
    database.close();
  }
}

export function writeArchive(filePath: string, events: FixtureEvent[], compressed: boolean): void {
  const content = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!compressed) {
    fs.writeFileSync(filePath, content);
    return;
  }
  const encoded = encodeSessionArchiveContent(content);
  if (encoded.suffix !== SESSION_ARCHIVE_ZSTD_SUFFIX) {
    throw new Error("test runtime does not support zstd");
  }
  fs.writeFileSync(filePath, encoded.bytes);
}

export function cleanupMediaPersistenceFixtures(tempDirs: string[]): void {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
}
