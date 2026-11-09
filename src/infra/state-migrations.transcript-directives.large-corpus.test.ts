import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareTranscriptPayload } from "../config/sessions/transcript-payload.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { mergeProcessEnv } from "./process-env.js";

const tempDir = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
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
  database.db.exec("COMMIT");
  const databasePath = database.path;
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
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
  expect(JSON.parse(result.stdout)).toEqual({ changes: [], warnings: [] });
  using verified = new DatabaseSync(databasePath, { readOnly: true });
  expect(verified.prepare("SELECT COUNT(*) AS count FROM transcript_events").get()?.count).toBe(
    rowsPerSession * payloads.length,
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
    JSON.parse(
      String(
        verified
          .prepare(`SELECT app_version FROM schema_meta
    WHERE meta_key = 'historical-transcript-directives-v1'`)
          .get()?.app_version,
      ),
    ),
  ).toEqual({ phase: "complete" });
}, 70_000);
