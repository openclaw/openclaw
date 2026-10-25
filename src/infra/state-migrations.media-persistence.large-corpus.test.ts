import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import {
  readSqliteTranscriptPayload,
  sqliteTranscriptPayloadColumns,
} from "../../scripts/lib/sqlite-transcript-payload.mjs";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabases } from "../state/openclaw-agent-db-lifecycle.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { mergeProcessEnv } from "./process-env.js";
import type { MigrationMessages } from "./state-migrations.types.js";

const SESSION_COUNT = 2_640;
const SESSION_WINDOW_COUNT = 300_000;
const SPARSE_EVENT_SESSION_COUNT = 4_096;
const ACTIVE_SESSIONS = 40;
const EVENTS_PER_SESSION = 128;
const PAYLOAD = "x".repeat(48 * 1024);
const tempDir = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawAgentDatabases();
    closeOpenClawStateDatabase();
    cleanup();
  });
});

function runMigration(
  stateDir: string,
  memoryMb?: number,
  countSelects = false,
): MigrationMessages & { migrationSelects?: number } {
  const heapLimit = memoryMb ? [`--max-old-space-size=${memoryMb}`] : [];
  const result = spawnSync(
    memoryMb ? resolveTestNodeExecPath() : process.execPath,
    [
      ...heapLimit,
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
  import { DatabaseSync } from "node:sqlite";
  import { resolveOpenClawAgentSqlitePath } from "./src/state/openclaw-agent-db.ts";
  let migrationSelects = 0;
  const prepare = DatabaseSync.prototype.prepare;
  if (${countSelects}) DatabaseSync.prototype.prepare = function (sql) {
    if (/^\\s*select/i.test(sql) &&
        /(transcript_events|trajectory_runtime_events|session_windows)/i.test(sql)) migrationSelects++;
    return prepare.call(this, sql);
  };
  const { migrateLegacyMediaPersistence } = await import("./src/infra/state-migrations.media-persistence.ts");
  const path = resolveOpenClawAgentSqlitePath({ agentId: "main", env: process.env });
  const migration = await migrateLegacyMediaPersistence({
    configuredAgentDatabaseTargets: [{ agentId: "main", path }], env: process.env,
  });
  process.stdout.write(JSON.stringify({ ...migration, ...(${countSelects} ? { migrationSelects } : {}) }));
    `,
    ],
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

function inspectCorpus(stateDir: string, sparse = false) {
  using db = new DatabaseSync(
    resolveOpenClawAgentSqlitePath({ agentId: "main", env: { OPENCLAW_STATE_DIR: stateDir } }),
    { readOnly: true },
  );
  const prefix = sparse ? "sparse-" : "large-corpus-";
  const read = (session: number, seq = 0) =>
    readSqliteTranscriptPayload(
      db
        .prepare(
          `SELECT ${sqliteTranscriptPayloadColumns(db)} FROM transcript_events WHERE session_id=? AND seq=?`,
        )
        .get(`${prefix}${session}`, seq),
    );
  const count = (table: string) => db.prepare(`SELECT COUNT(*) count FROM ${table}`).get()?.count;
  const media = (message: {
    ["__openclaw"]?: { media?: { path: string }[] };
    MediaPath?: string;
  }) => [message["__openclaw"]?.media?.[0]?.path, Object.hasOwn(message, "MediaPath")];
  const first = JSON.parse(read(0));
  const boundary = JSON.parse(read(0, sparse ? 0 : 64));
  const trajectory = JSON.parse(
    String(
      db
        .prepare("SELECT event_json FROM trajectory_runtime_events WHERE session_id=? AND seq=?")
        .get(`${prefix}${sparse ? SPARSE_EVENT_SESSION_COUNT - 1 : 0}`, sparse ? 0 : 64)
        ?.event_json,
    ),
  );
  return {
    sessions: count("session_nodes"),
    windows: count("session_windows"),
    events: count("transcript_events"),
    trajectoryEvents: count("trajectory_runtime_events"),
    firstIdentity: [first.type, first.id, first.parentId],
    firstMedia: media(first.message),
    boundaryMedia: media(boundary.message),
    trajectoryMedia: media(trajectory.data.messagesSnapshot[0]),
    survivors: sparse
      ? []
      : [read(20, 64), read(39, 127)].map((value) =>
          createHash("sha256").update(value).digest("hex"),
        ),
  };
}

function createCorpus(stateDir: string, sparse = false): void {
  const prefix = sparse ? "sparse-" : "large-corpus-";
  const sessions = sparse ? SPARSE_EVENT_SESSION_COUNT : SESSION_COUNT;
  const active = sparse ? sessions : ACTIVE_SESSIONS;
  const events = sparse ? 1 : EVENTS_PER_SESSION;
  const content = sparse ? "sparse" : PAYLOAD;
  const db = createWindows(stateDir, prefix, sessions).db;
  const grid = `WITH RECURSIVE s(i) AS (
    VALUES(0) UNION ALL SELECT i+1 FROM s WHERE i+1 < $sessions
  ), e(seq) AS (VALUES(0) UNION ALL SELECT seq+1 FROM e WHERE seq+1 < $events)`;
  const common = { $events: events, $prefix: prefix, $sparse: Number(sparse) };
  db.prepare(`${grid}
  INSERT INTO transcript_events(session_id,seq,event_json,created_at,navigation_type,navigation_last_type,message_role)
    SELECT $prefix||i, seq,
      json_object('type','message','id',
        CASE WHEN $sparse THEN 'transcript-'||i ELSE 'event-'||i||'-'||seq END,
        'parentId',NULL,'message',
        CASE WHEN i=0 AND seq=0 THEN json_object('role','user','content',$content,'MediaPath',$media)
          WHEN i=0 AND seq=64 THEN json_object('role','user','content',$content,'MediaPath','/media/boundary.png')
          ELSE json_object('role','user','content',$content) END),
      CASE WHEN $sparse THEN i+1 ELSE seq+1 END, 'message', 'message', 'user' FROM s CROSS JOIN e`).run(
    {
      ...common,
      $sessions: active,
      $content: content,
      $media: sparse ? "/media/transcript.png" : "/media/legacy.png",
    },
  );
  db.prepare(`${grid}
  INSERT INTO trajectory_runtime_events(session_id,seq,run_id,event_json,created_at)
    SELECT $prefix||i, seq, CASE WHEN $sparse THEN 'run-'||i ELSE 'run-large-corpus' END,
      json_object('type','model.completed','data',json_object('messagesSnapshot',json_array(
        CASE WHEN i=$last AND seq=$seq THEN json_object('role','user','content',$content,'MediaPath',$media)
          ELSE json_object('role','user','content',$content) END))),
      CASE WHEN $sparse THEN i+1 ELSE seq+1 END FROM s CROSS JOIN e`).run({
    ...common,
    $sessions: sparse ? sessions : 1,
    $last: sparse ? sessions - 1 : 0,
    $seq: sparse ? 0 : 64,
    $content: sparse ? "sparse" : "trajectory",
    $media: sparse ? "/media/trajectory.png" : "/media/trajectory-boundary.png",
  });
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
  expect(runMigration(stateDir, 256)).toEqual({
    changes: [],
    warnings: [],
  });
}, 130_000);

it("does not materialize every session window under a 128 MiB old-space cap", () => {
  const stateDir = tempDir.make("openclaw-media-session-windows-");
  finishCorpus(createWindows(stateDir, "window-", SESSION_WINDOW_COUNT).db);
  const output = runMigration(stateDir, 128);
  expect(output).toEqual({ changes: [], warnings: [] });
}, 130_000);

it("rewrites bounded batches under a 256 MiB old-space cap", () => {
  const stateDir = tempDir.make("openclaw-media-corpus-");
  createCorpus(stateDir);
  const before = inspectCorpus(stateDir).survivors;
  expect(runMigration(stateDir, 256)).toMatchObject({
    warnings: [],
    changes: [
      expect.stringContaining("Saved pre-repair SQLite backup:"),
      expect.stringContaining("1 transcript session(s), 1 trajectory row(s),"),
    ],
  });
  const after = inspectCorpus(stateDir);
  expect(after).toMatchObject({
    sessions: SESSION_COUNT,
    windows: SESSION_COUNT,
    events: ACTIVE_SESSIONS * EVENTS_PER_SESSION,
    trajectoryEvents: EVENTS_PER_SESSION,
    firstIdentity: ["message", "event-0-0", null],
    firstMedia: ["/media/legacy.png", false],
    boundaryMedia: ["/media/boundary.png", false],
    trajectoryMedia: ["/media/trajectory-boundary.png", false],
  });
  expect(after.survivors).toEqual(before);
}, 130_000);

it("bounds SQLite crossings across many event-bearing sessions", () => {
  const stateDir = tempDir.make("openclaw-media-sparse-events-");
  createCorpus(stateDir, true);
  const output = runMigration(stateDir, undefined, true);
  expect(output).toMatchObject({
    warnings: [],
    changes: [
      expect.stringContaining("Saved pre-repair SQLite backup:"),
      expect.stringContaining("1 transcript session(s), 1 trajectory row(s),"),
    ],
  });
  expect(inspectCorpus(stateDir, true)).toMatchObject({
    firstMedia: ["/media/transcript.png", false],
    trajectoryMedia: ["/media/trajectory.png", false],
  });
  expect(output.migrationSelects).toBeLessThan(1_000);
}, 130_000);
