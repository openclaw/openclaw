import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { createTranscriptEventInserter } from "../config/sessions/transcript-payload.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { doctorConfigRuntimeEntrypoints } from "./doctor-config-runtime.test-support.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());
const execFileAsync = promisify(execFile);

it("repairs deep owner aliases without losing a large healthy transcript", async () => {
  await withStateDirEnv("openclaw-doctor-canonical-scale-", async ({ stateDir }) => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
    const storePath = resolveSessionStorePathCore(storeTemplate, { agentId: "main", env });
    const databaseOptions = {
      agentId: "main",
      env,
      path: resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main", env }).path,
    };
    const { db } = openOpenClawAgentDatabase(databaseOptions);
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
    db.exec("BEGIN");
    try {
      for (let index = 0; index <= aliasCount; index += 1) {
        const currentId = `scale-${Math.min(index + 1, aliasCount)}`;
        node.run(
          key(index),
          currentId,
          index === aliasCount ? JSON.stringify({ sessionId, updatedAt: 10 }) : "{}",
          index === aliasCount ? 1 : 0,
        );
        window.run(`scale-${index}`, key(index));
      }
      for (let seq = 0; seq < eventCount; seq += 1) {
        const id = `event-${seq}`;
        const parentId = seq === 0 ? null : `event-${seq - 1}`;
        insertEvent({
          seq,
          eventJson: JSON.stringify({
            id,
            parentId,
            type: "message",
            message: { role: "user", content: `history ${seq}` },
          }),
          createdAt: 10,
        });
        identity.run(sessionId, id, seq, parentId);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    closeOpenClawAgentDatabasesForTest();
    const child = resolveRuntimeWorkerUrl(doctorConfigRuntimeEntrypoints.canonicalSessionRepair);
    // Doctor runs on Node's main thread; Vitest's worker-thread stack masks this overflow.
    const { stdout } = await execFileAsync(
      process.execPath,
      [...resolveRuntimeWorkerArgv(child), stateDir, storeTemplate, "apply"],
      { cwd: process.cwd(), env, encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 60_000 },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      foundGroups: 1,
      repairedGroups: 1,
      removedRows: aliasCount,
    });
    const { db: verified } = openOpenClawAgentDatabase(databaseOptions);
    expect(verified.prepare("SELECT count(*) AS count FROM transcript_events").get()).toEqual({
      count: eventCount,
    });
    expect(verified.prepare("SELECT count(*) AS count FROM session_nodes").get()).toEqual({
      count: 1,
    });
    expect(
      verified.prepare("SELECT session_key, current_session_id FROM session_nodes").get(),
    ).toEqual({
      session_key: key(aliasCount),
      current_session_id: sessionId,
    });
    expect(verified.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
