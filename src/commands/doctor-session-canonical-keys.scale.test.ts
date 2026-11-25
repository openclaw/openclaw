import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createTranscriptEventInserter } from "../config/sessions/transcript-payload.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { doctorConfigRuntimeEntrypoints } from "./doctor-config-runtime.test-support.js";
import { runDoctorChild } from "./doctor-session-child.test-support.js";
import { createCanonicalRepairFixture } from "./doctor-session-repair-fixture.test-support.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());

it("repairs deep owner aliases without losing a large healthy transcript", async () => {
  await withStateDirEnv("openclaw-doctor-canonical-scale-", async ({ stateDir }) => {
    const { env, database } = createCanonicalRepairFixture(stateDir);
    const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
    const { db } = database();
    const aliasCount = 12_000;
    const eventCount = 200_000;
    const key = (index: number) => `agent:main:dashboard:scale-${String(index).padStart(5, "0")}`;
    const node = db.prepare(
      "INSERT INTO session_nodes (session_key, current_session_id, entry_json, entry_valid, updated_at) VALUES (?, ?, ?, ?, 10)",
    );
    const window = db.prepare(
      "INSERT INTO session_windows (session_id, session_key, reason, session_scope, created_at, updated_at) VALUES (?, ?, 'initial', 'conversation', 10, 10)",
    );
    const identity = db.prepare(
      "INSERT INTO transcript_event_identities (session_id, event_id, seq, event_type, parent_id, created_at) VALUES (?, ?, ?, 'message', ?, 10)",
    );
    const sessionId = `scale-${aliasCount}`;
    const insertEvent = createTranscriptEventInserter(db, sessionId);
    runSqliteDeferredTransactionSync(db, () => {
      for (let index = 0; index <= aliasCount; index += 1) {
        const currentId = `scale-${Math.min(index + 1, aliasCount)}`;
        const valid = Number(index === aliasCount);
        const entry = valid ? { sessionId, updatedAt: 10 } : {};
        node.run(key(index), currentId, JSON.stringify(entry), valid);
        window.run(`scale-${index}`, key(index));
      }
      for (let seq = 0; seq < eventCount; seq += 1) {
        const id = `event-${seq}`;
        const parentId = seq === 0 ? null : `event-${seq - 1}`;
        const message = { role: "user", content: `history ${seq}` };
        const eventJson = JSON.stringify({ id, parentId, type: "message", message });
        insertEvent({ seq, eventJson, createdAt: 10 });
        identity.run(sessionId, id, seq, parentId);
      }
    });
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    closeOpenClawAgentDatabasesForTest();
    const child = resolveRuntimeWorkerUrl(doctorConfigRuntimeEntrypoints.canonicalSessionRepair);
    // Doctor runs on Node's main thread; Vitest's worker-thread stack masks this overflow.
    const report = await runDoctorChild(
      [...resolveRuntimeWorkerArgv(child), stateDir, storeTemplate, "apply"],
      env,
    );
    expect(report).toMatchObject({
      foundGroups: 1,
      repairedGroups: 1,
      removedRows: aliasCount,
    });
    const { db: verified } = database();
    expect(
      verified
        .prepare(
          "SELECT session_key, current_session_id, (SELECT count(*) FROM transcript_events) AS events, (SELECT count(*) FROM session_nodes) AS nodes FROM session_nodes",
        )
        .get(),
    ).toEqual({
      session_key: key(aliasCount),
      current_session_id: sessionId,
      events: eventCount,
      nodes: 1,
    });
    expect(verified.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
