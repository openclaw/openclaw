import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { deriveTranscriptPredicateFields } from "../config/sessions/transcript-predicate-fields.js";
import { closeOpenClawAgentDatabases } from "../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { mergeProcessEnv } from "./process-env.js";

const SESSION_COUNT = 2_640;
const SESSION_WINDOW_COUNT = 300_000;
const SPARSE_EVENT_SESSION_COUNT = 4_096;
const ACTIVE_SESSIONS = 40;
const EVENTS_PER_SESSION = 128;
const PAYLOAD = "x".repeat(48 * 1024);
const messagePredicates = deriveTranscriptPredicateFields(
  '{"type":"message","message":{"role":"user"}}',
);
const tempDir = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawAgentDatabases();
    closeOpenClawStateDatabase();
    cleanup();
  });
});

function runMigration(stateDir: string, script: string, memoryMb?: number): unknown {
  const heapLimit = memoryMb ? [`--max-old-space-size=${memoryMb}`] : [];
  const result = spawnSync(
    memoryMb ? resolveTestNodeExecPath() : process.execPath,
    [...heapLimit, "--import", "tsx", "--input-type=module", "-e", script],
    { cwd: process.cwd(), encoding: "utf8", env: migrationChildEnv(stateDir), timeout: 120_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

function createWindows(stateDir: string, prefix: string, count: number) {
  const database = openOpenClawAgentDatabase({
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
  database.db.exec("BEGIN");
  database.db
    .prepare(`WITH RECURSIVE n(i) AS (
    VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i+1 < ?
  ) INSERT INTO session_nodes(session_key,current_session_id,entry_json,entry_valid,updated_at)
    SELECT 'agent:main:'||?||i, ?||i,
      json_object('sessionId',?||i,'updatedAt',i+1), 1, i+1 FROM n`)
    .run(count, prefix, prefix, prefix);
  database.db.exec(`INSERT INTO session_windows(session_id,session_key,created_at,updated_at)
    SELECT current_session_id,session_key,updated_at,updated_at FROM session_nodes`);
  return database;
}

function migrationChildEnv(stateDir: string): NodeJS.ProcessEnv {
  // Measure migration memory, not tsx's index of unrelated projects' cached modules.
  const loaderTempDir = tempDir.make("loader-", stateDir);
  return mergeProcessEnv([
    process.env,
    {
      OPENCLAW_STATE_DIR: stateDir,
      TMPDIR: loaderTempDir,
      TMP: loaderTempDir,
      TEMP: loaderTempDir,
    },
  ]);
}

const MEDIA_CARRIER_SCRIPT = String.raw`
  const mediaCarrier = (message) => [message.__openclaw?.media?.[0]?.path,
    Object.hasOwn(message, "MediaPath")];
`;
const CHILD_IMPORTS = String.raw`
  import { DatabaseSync } from "node:sqlite";
  import { resolveOpenClawAgentSqlitePath } from "./src/state/openclaw-agent-db.ts";
  import { readSqliteTranscriptPayload, sqliteTranscriptPayloadColumns } from "./scripts/lib/sqlite-transcript-payload.mjs";
`;
const MIGRATE_SCRIPT = String.raw`
  const migration = await migrateLegacyMediaPersistence({
    configuredAgentDatabaseTargets: [{ agentId: "main", path }], env: process.env,
  });
`;
const CHILD_SCRIPT = String.raw`
  import { createHash } from "node:crypto";
  import { migrateLegacyMediaPersistence } from "./src/infra/state-migrations.media-persistence.ts";
  ${CHILD_IMPORTS}
  const path = resolveOpenClawAgentSqlitePath({ agentId: "main", env: process.env });
  let db = new DatabaseSync(path, { readOnly: true });
  const read = (session, seq) => readSqliteTranscriptPayload(db.prepare(
    "SELECT " + sqliteTranscriptPayloadColumns(db) + " FROM transcript_events WHERE session_id=? AND seq=?",
  ).get(session, seq));
  const readTrajectory = (seq) => db.prepare(
    "SELECT event_json FROM trajectory_runtime_events WHERE session_id=? AND seq=?",
  ).get("large-corpus-0", seq).event_json;
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const before = [hash(read("large-corpus-20", 64)), hash(read("large-corpus-39", 127))];
  db.close();
  ${MIGRATE_SCRIPT}
  db = new DatabaseSync(path, { readOnly: true });
  const count = (table) => db.prepare("SELECT COUNT(*) count FROM " + table).get().count;
  const first = JSON.parse(read("large-corpus-0", 0));
  const boundary = JSON.parse(read("large-corpus-0", 64));
  const trajectoryBoundary = JSON.parse(readTrajectory(64));
  ${MEDIA_CARRIER_SCRIPT}
  process.stdout.write(JSON.stringify({
    warnings: migration.warnings,
    changes: migration.changes,
    sessions: count("session_nodes"), windows: count("session_windows"),
    events: count("transcript_events"),
    trajectoryEvents: count("trajectory_runtime_events"),
    firstIdentity: [first.type, first.id, first.parentId],
    firstMedia: mediaCarrier(first.message),
    boundaryMedia: mediaCarrier(boundary.message),
    trajectoryBoundaryMedia: mediaCarrier(trajectoryBoundary.data.messagesSnapshot[0]),
    middlePreserved: hash(read("large-corpus-20", 64)) === before[0],
    lastPreserved: hash(read("large-corpus-39", 127)) === before[1],
  }) + "\n");
  db.close();
`;
const SESSION_WINDOW_CHILD_SCRIPT = String.raw`
  import { resolveOpenClawAgentSqlitePath } from "./src/state/openclaw-agent-db.ts";
  import { migrateLegacyMediaPersistence } from "./src/infra/state-migrations.media-persistence.ts";
  const path = resolveOpenClawAgentSqlitePath({ agentId: "main", env: process.env });
  ${MIGRATE_SCRIPT}
  process.stdout.write(JSON.stringify(migration) + "\n");
`;
const SPARSE_EVENT_CHILD_SCRIPT = String.raw`
  ${CHILD_IMPORTS}
  const originalPrepare = DatabaseSync.prototype.prepare;
  let mediaSelects = 0;
  DatabaseSync.prototype.prepare = function (sql) {
    if (/^\s*select/i.test(sql) &&
        /(transcript_events|trajectory_runtime_events|session_windows)/i.test(sql)) {
      mediaSelects += 1;
    }
    return originalPrepare.call(this, sql);
  };
  const { migrateLegacyMediaPersistence } = await import(
    "./src/infra/state-migrations.media-persistence.ts"
  );
  const path = resolveOpenClawAgentSqlitePath({ agentId: "main", env: process.env });
  ${MIGRATE_SCRIPT}
  const migrationSelects = mediaSelects;
  const db = new DatabaseSync(path, { readOnly: true });
  const transcript = JSON.parse(readSqliteTranscriptPayload(db.prepare(
    "SELECT " + sqliteTranscriptPayloadColumns(db) + " FROM transcript_events WHERE session_id=? AND seq=0",
  ).get("sparse-0")));
  const trajectory = JSON.parse(db.prepare(
    "SELECT event_json FROM trajectory_runtime_events WHERE session_id=? AND seq=0",
  ).get("sparse-${SPARSE_EVENT_SESSION_COUNT - 1}").event_json);
  ${MEDIA_CARRIER_SCRIPT}
  process.stdout.write(JSON.stringify({
    warnings: migration.warnings,
    changes: migration.changes,
    migrationSelects,
    transcriptMedia: mediaCarrier(transcript.message),
    trajectoryMedia: mediaCarrier(trajectory.data.messagesSnapshot[0]),
  }) + "\n");
  db.close();
`;

function createCorpus(stateDir: string, sparse = false): void {
  const prefix = sparse ? "sparse-" : "large-corpus-";
  const sessions = sparse ? SPARSE_EVENT_SESSION_COUNT : SESSION_COUNT;
  const active = sparse ? sessions : ACTIVE_SESSIONS;
  const events = sparse ? 1 : EVENTS_PER_SESSION;
  const content = sparse ? "sparse" : PAYLOAD;
  const db = createWindows(stateDir, prefix, sessions).db;
  db.prepare(`WITH RECURSIVE s(i) AS (
    VALUES(0) UNION ALL SELECT i+1 FROM s WHERE i+1 < ?
  ), e(seq) AS (VALUES(0) UNION ALL SELECT seq+1 FROM e WHERE seq+1 < ?)
  INSERT INTO transcript_events(session_id,seq,event_json,created_at,navigation_type,navigation_last_type,message_role)
    SELECT ?||i, seq,
      json_object('type','message','id',
        CASE WHEN ? THEN 'transcript-'||i ELSE 'event-'||i||'-'||seq END,
        'parentId',NULL,'message',
        CASE WHEN i=0 AND seq=0 THEN json_object('role','user','content',?,'MediaPath',?)
          WHEN i=0 AND seq=64 THEN json_object('role','user','content',?,'MediaPath','/media/boundary.png')
          ELSE json_object('role','user','content',?) END),
      CASE WHEN ? THEN i+1 ELSE seq+1 END, ?, ?, ? FROM s CROSS JOIN e`).run(
    active,
    events,
    prefix,
    Number(sparse),
    content,
    sparse ? "/media/transcript.png" : "/media/legacy.png",
    content,
    content,
    Number(sparse),
    messagePredicates.navigation_type,
    messagePredicates.navigation_last_type,
    messagePredicates.message_role,
  );
  db.prepare(`WITH RECURSIVE s(i) AS (
    VALUES(0) UNION ALL SELECT i+1 FROM s WHERE i+1 < ?
  ), e(seq) AS (VALUES(0) UNION ALL SELECT seq+1 FROM e WHERE seq+1 < ?)
  INSERT INTO trajectory_runtime_events(session_id,seq,run_id,event_json,created_at)
    SELECT ?||i, seq, CASE WHEN ? THEN 'run-'||i ELSE 'run-large-corpus' END,
      json_object('type','model.completed','data',json_object('messagesSnapshot',json_array(
        CASE WHEN i=? AND seq=? THEN json_object('role','user','content',?,'MediaPath',?)
          ELSE json_object('role','user','content',?) END))),
      CASE WHEN ? THEN i+1 ELSE seq+1 END FROM s CROSS JOIN e`).run(
    sparse ? sessions : 1,
    events,
    prefix,
    Number(sparse),
    sparse ? sessions - 1 : 0,
    sparse ? 0 : 64,
    sparse ? "sparse" : "trajectory",
    sparse ? "/media/trajectory.png" : "/media/trajectory-boundary.png",
    sparse ? "sparse" : "trajectory",
    Number(sparse),
  );
  finishCorpus(db);
}

function finishCorpus(db: ReturnType<typeof createWindows>["db"]) {
  db.exec("COMMIT; UPDATE session_nodes SET entry_valid=1");
  closeOpenClawAgentDatabases();
}

it("bounds retained payload bytes when a row batch contains oversized identity events", () => {
  const stateDir = tempDir.make("openclaw-media-oversized-events-");
  const database = createWindows(stateDir, "oversized-", 1);
  database.db
    .prepare(`WITH RECURSIVE n(i) AS (
      VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i+1 < 65
    ) INSERT INTO transcript_events(session_id,seq,event_json,created_at)
      SELECT 'oversized-0', i, json_object('type','custom','customType','synthetic',
        'data', ?), i+1 FROM n`)
    .run("x".repeat(8 * 1024 * 1024));
  database.db.exec("COMMIT");
  closeOpenClawAgentDatabases();
  expect(runMigration(stateDir, SESSION_WINDOW_CHILD_SCRIPT, 256)).toEqual({
    changes: [],
    warnings: [],
  });
}, 130_000);

it("does not materialize every session window under a 128 MiB old-space cap", () => {
  const stateDir = tempDir.make("openclaw-media-session-windows-");
  finishCorpus(createWindows(stateDir, "window-", SESSION_WINDOW_COUNT).db);
  const output = runMigration(stateDir, SESSION_WINDOW_CHILD_SCRIPT, 128);
  expect(output).toEqual({ changes: [], warnings: [] });
}, 130_000);

it("rewrites bounded batches under a 256 MiB old-space cap", () => {
  const stateDir = tempDir.make("openclaw-media-corpus-");
  createCorpus(stateDir);
  const output = runMigration(stateDir, CHILD_SCRIPT, 256);
  expect(output).toMatchObject({
    warnings: [],
    changes: [
      expect.stringContaining("Saved pre-repair SQLite backup:"),
      expect.stringContaining("1 transcript session(s), 1 trajectory row(s),"),
    ],
    sessions: SESSION_COUNT,
    windows: SESSION_COUNT,
    events: ACTIVE_SESSIONS * EVENTS_PER_SESSION,
    trajectoryEvents: EVENTS_PER_SESSION,
    firstIdentity: ["message", "event-0-0", null],
    firstMedia: ["/media/legacy.png", false],
    boundaryMedia: ["/media/boundary.png", false],
    trajectoryBoundaryMedia: ["/media/trajectory-boundary.png", false],
    middlePreserved: true,
    lastPreserved: true,
  });
}, 130_000);

it("bounds SQLite crossings across many event-bearing sessions", () => {
  const stateDir = tempDir.make("openclaw-media-sparse-events-");
  createCorpus(stateDir, true);
  const output = runMigration(stateDir, SPARSE_EVENT_CHILD_SCRIPT) as {
    changes: string[];
    migrationSelects: number;
    transcriptMedia: [string, boolean];
    trajectoryMedia: [string, boolean];
    warnings: string[];
  };
  expect(output).toMatchObject({
    warnings: [],
    changes: [
      expect.stringContaining("Saved pre-repair SQLite backup:"),
      expect.stringContaining("1 transcript session(s), 1 trajectory row(s),"),
    ],
    transcriptMedia: ["/media/transcript.png", false],
    trajectoryMedia: ["/media/trajectory.png", false],
  });
  expect(output.migrationSelects).toBeLessThan(1_000);
}, 130_000);
