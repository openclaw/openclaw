import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { withSuppressedNotes } from "../../packages/terminal-core/src/note.js";
import { transcriptEventJsonSql } from "../config/sessions/transcript-payload.js";
import { getNodeSqliteKysely, prepareSqliteQueryIterator } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { resolveTargetSqlitePath } from "../infra/session-sqlite-migration-readers.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import { noteSessionTranscriptHealth } from "./doctor-session-transcripts.js";

export const sqliteImportMemorySupportUrl = import.meta.url;

async function main() {
  const [stateDir, scenario] = process.argv.slice(2);
  assert(stateDir && scenario);
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
  const sessionCount = scenario === "batch" ? 256 : 1;
  // Public payload is 390.625 MiB: exceed the child heap while retaining deep ancestry.
  const eventCount = scenario === "public" ? 25_000 : scenario === "batch" ? 64 : 8;
  const payloadBytes = scenario === "public" ? 16_384 : scenario === "batch" ? 32768 : 256;
  const expectedProjection = [eventCount - 1, eventCount - 1, `e-${eventCount - 2}`, 0];
  const sessionsDir = path.join(stateDir, "agents/main/sessions");
  const storePath = path.join(sessionsDir, "sessions.json");
  const importSessions = () =>
    runDoctorSessionSqlite({ mode: "import", store: storePath, env: process.env });
  fs.mkdirSync(sessionsDir, { recursive: true });
  const store: Record<string, { sessionId: string; updatedAt: number; sessionFile: string }> = {};
  const expected = new Map<string, string>();
  const timestamp = 1_800_000_000_000;
  const stamp = new Date(timestamp).toISOString();
  const tool = { role: "toolResult", toolName: "exec", isError: false, timestamp };
  for (let session = 0; session < sessionCount; session++) {
    const id = `memory-${session}`;
    const transcriptPath = path.join(sessionsDir, `${id}.jsonl`);
    const entry = { sessionId: id, updatedAt: timestamp, sessionFile: transcriptPath };
    store[`agent:main:memory-${session}`] = entry;
    const fd = fs.openSync(transcriptPath, "wx", 0o600);
    const hash = createHash("sha256");
    const write = (event: unknown) => {
      const json = JSON.stringify(event);
      hash.update(json).update("\n");
      fs.writeSync(fd, `${json}\n`);
    };
    try {
      write({ type: "session", version: 3, id, timestamp: stamp, cwd: "/fixture" });
      for (let index = 0; index < eventCount; index++) {
        const eventId = `e-${index}`;
        const parentId = index === 0 ? null : `e-${index - 1}`;
        const toolCallId = `call-${index}`;
        const text = `${session}:${index}:é🦞${"x".repeat(payloadBytes)}`;
        const message = { ...tool, toolCallId, content: [{ type: "text", text }] };
        write({ type: "message", id: eventId, parentId, timestamp, message });
      }
      // Force the full projection owner, including a deep selected ancestry.
      write({
        type: "leaf",
        id: "selected-leaf",
        parentId: `e-${eventCount - 1}`,
        targetId: `e-${eventCount - 2}`,
      });
    } finally {
      fs.closeSync(fd);
    }
    expected.set(id, hash.digest("hex"));
  }
  fs.writeFileSync(storePath, JSON.stringify(store));
  process.stderr.write(`seeded ${sessionCount} sessions x ${eventCount} events; importing\n`);
  if (scenario === "public") {
    await withSuppressedNotes(() =>
      noteSessionTranscriptHealth({
        cfg: { agents: { entries: { main: {} } } },
        env: process.env,
        shouldRepair: true,
      }),
    );
    assert(!fs.readdirSync(sessionsDir).some((name) => name.includes(".pre-doctor-")));
  }
  const report = await importSessions();
  assert.equal(report.totals.issues, 0, JSON.stringify(report.targets.map((t) => t.issues)));
  assert.equal(report.totals.importedEntries, scenario === "public" ? 0 : sessionCount);
  assert.equal(
    report.totals.importedTranscriptEvents,
    scenario === "public" ? 0 : sessionCount * (eventCount + 2),
  );
  const db = openNodeSqliteDatabase(resolveTargetSqlitePath({ agentId: "main", storePath }), {
    readOnly: true,
  });
  try {
    const projection = db.prepare(
      "SELECT active_event_count, active_message_count, leaf_event_id, needs_rebuild FROM session_transcript_index_state WHERE session_id = ?",
    );
    const read = prepareSqliteQueryIterator<string, { event_json: string }>(db, (parameter) =>
      getNodeSqliteKysely<Pick<DB, "transcript_events">>(db)
        .selectFrom("transcript_events")
        .select(transcriptEventJsonSql(db).as("event_json"))
        .where(
          "session_id",
          "=",
          parameter((sessionId) => sessionId),
        )
        .orderBy("seq"),
    );
    for (const [sessionId, digest] of expected) {
      const hash = createHash("sha256");
      for (const row of read(sessionId)) {
        hash.update(row.event_json).update("\n");
      }
      assert.equal(hash.digest("hex"), digest);
      assert.deepEqual(Object.values(projection.get(sessionId)!), expectedProjection);
    }
  } finally {
    db.close();
  }
  const rerun = await importSessions();
  assert.equal(rerun.totals.importedEntries, 0);
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  process.stdout.write(JSON.stringify({ scenario }));
}
// Node resolves the bundled module through a worktree's shared node_modules
// symlink; resolve argv too or the child exits without running the proof.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  await main();
}
