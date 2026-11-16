import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareTranscriptPayload } from "../config/sessions/transcript-payload.js";
import { closeOpenClawAgentDatabases } from "../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { prepareTrajectoryPayload } from "../trajectory/runtime-payload.js";
import { mergeProcessEnv } from "./process-env.js";

const tempDir = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawAgentDatabases();
    closeOpenClawStateDatabase();
    cleanup();
  });
});

it("completes compressed history under a 256 MiB heap with long nonmatching and candidate scans", () => {
  const stateDir = tempDir.make("transcript-directive-corpus-");
  const database = openOpenClawAgentDatabase({
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
  const rowsPerSession = 4_096;
  const payloads = ["unchanged", "[[candidate"].map((data) =>
    prepareTranscriptPayload(
      database.db,
      JSON.stringify({ type: "custom", customType: "synthetic", data: data + "x".repeat(65_536) }),
    ),
  );
  database.db.exec("BEGIN");
  for (const [index, payload] of payloads.entries()) {
    expect(payload.event_zstd).not.toBeNull();
    const sessionId = `corpus-${index}`;
    const sessionKey = `agent:main:${sessionId}`;
    database.db
      .prepare(`INSERT INTO session_nodes
      (session_key,current_session_id,entry_json,updated_at) VALUES(?,?,'{}',1)`)
      .run(sessionKey, sessionId);
    database.db
      .prepare(`INSERT INTO session_windows
      (session_id,session_key,created_at,updated_at) VALUES(?,?,1,1)`)
      .run(sessionId, sessionKey);
    database.db
      .prepare(`WITH RECURSIVE n(i) AS (
      VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i+1 < ?
    ) INSERT INTO transcript_events
      (session_id,seq,event_json,event_zstd,event_utf8_bytes,navigation_json,created_at)
      SELECT ?,i,NULL,?,?,?,1 FROM n`)
      .run(
        rowsPerSession,
        sessionId,
        payload.event_zstd,
        payload.event_utf8_bytes,
        payload.navigation_json,
      );
  }
  const providerEvent = JSON.stringify({
    type: "message",
    id: "masked",
    message: {
      role: "assistant",
      provider: "***",
      model: "fixture-model",
      content: [{ type: "text", text: "Retained answer" }],
    },
  });
  database.db.exec(`INSERT INTO session_nodes
    (session_key,current_session_id,entry_json,updated_at)
    VALUES('agent:main:provider','provider','{}',1);
    INSERT INTO session_windows(session_id,session_key,created_at,updated_at)
    VALUES('provider','agent:main:provider',1,1)`);
  database.db
    .prepare(`INSERT INTO transcript_events(session_id,seq,event_json,created_at)
    VALUES('provider',0,?,1)`)
    .run(providerEvent);
  const trajectory = prepareTrajectoryPayload(
    database.db,
    JSON.stringify({
      modelId: "fixture-model",
      provider: "fixture-provider",
      data: "x".repeat(65_536),
    }),
  );
  expect(trajectory.event_payload).not.toBeNull();
  database.db
    .prepare(`WITH RECURSIVE n(i) AS (
    VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i+1 < ?
  ) INSERT INTO trajectory_runtime_events
    (session_id,seq,run_id,event_json,event_payload,event_codec,event_utf8_bytes,created_at)
    SELECT 'provider',i,'synthetic',?,?,?,?,1 FROM n`)
    .run(
      rowsPerSession,
      trajectory.event_json,
      trajectory.event_payload,
      trajectory.event_codec,
      trajectory.event_utf8_bytes,
    );
  database.db.exec("COMMIT");
  const databasePath = database.path;
  closeOpenClawAgentDatabases();
  closeOpenClawStateDatabase();
  // Keep tsx's unrelated cache inventory out of the constrained child heap.
  const loaderTempDir = tempDir.make("loader-", stateDir);
  const result = spawnSync(
    resolveTestNodeExecPath(),
    [
      "--max-old-space-size=256",
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { migrateHistoricalTranscriptDirectives } from "./src/infra/state-migrations.transcript-directives.ts";
     const result = await migrateHistoricalTranscriptDirectives({ env: process.env,
       configuredAgentDatabaseTargets: [{ agentId: "main", path: ${JSON.stringify(databasePath)} }] });
     process.stdout.write(JSON.stringify(result));`,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 60_000,
      env: mergeProcessEnv([
        process.env,
        {
          OPENCLAW_STATE_DIR: stateDir,
          TMPDIR: loaderTempDir,
          TMP: loaderTempDir,
          TEMP: loaderTempDir,
        },
      ]),
    },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    changes: [
      `Restored masked provider on 1 historical transcript row(s) in ${databasePath} from recorded session runtime facts.`,
      `Repaired historical transcripts in ${databasePath}: 1 active session(s), 0 archived transcript(s).`,
    ],
    warnings: [],
  });
  using verified = new DatabaseSync(databasePath, { readOnly: true });
  expect(verified.prepare("SELECT COUNT(*) AS count FROM transcript_events").get()?.count).toBe(
    rowsPerSession * payloads.length + 1,
  );
  for (const [index, payload] of payloads.entries()) {
    expect(
      verified
        .prepare(`SELECT COUNT(*) AS count FROM transcript_events
      WHERE session_id = ? AND (event_json IS NOT NULL OR event_zstd <> ?
        OR event_utf8_bytes <> ? OR navigation_json <> ?)`)
        .get(
          `corpus-${index}`,
          payload.event_zstd,
          payload.event_utf8_bytes,
          payload.navigation_json,
        )?.count,
    ).toBe(0);
  }
  expect(
    verified
      .prepare(`SELECT event_json FROM transcript_events
    WHERE session_id = 'provider' AND seq = 0`)
      .get()?.event_json,
  ).toBe(providerEvent.replace('"provider":"***"', '"provider":"fixture-provider"'));
  expect(
    verified
      .prepare(`SELECT COUNT(*) AS count FROM trajectory_runtime_events
    WHERE event_payload = ? AND event_utf8_bytes = ?`)
      .get(trajectory.event_payload, trajectory.event_utf8_bytes)?.count,
  ).toBe(rowsPerSession);
  expect(
    JSON.parse(
      String(
        verified
          .prepare(`SELECT app_version FROM schema_meta
    WHERE meta_key = 'historical-transcript-directives-v1'`)
          .get()?.app_version,
      ),
    ),
  ).toEqual({ phase: "complete", version: 2 });
}, 70_000);
