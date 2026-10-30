import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { doctorConfigRuntimeEntrypoints } from "./doctor-config-runtime.test-support.js";
import { runDoctorChild } from "./doctor-session-child.test-support.js";
import { sessionSqlFixture } from "./doctor-session-sqlite.sql.test-support.js";

const ROW_COUNT = 48;
const ENTRY_PAYLOAD_BYTES = 512 * 1024;
const CHILD_HEAP_MIB = 160;
const child = resolveRuntimeWorkerUrl(doctorConfigRuntimeEntrypoints.canonicalSessionRepair);

function payloadFor(index: number): string {
  const prefix = `recovered prompt snapshot ${index}:`;
  return `${prefix}${"x".repeat(ENTRY_PAYLOAD_BYTES - prefix.length)}`;
}

const sessionKeyFor = (index: number) =>
  index === 0
    ? "agent:main:main"
    : `agent:main:dashboard:memory-${index.toString().padStart(4, "0")}`;

it("keeps canonical SQLite entry JSON streaming under a low child heap", async () => {
  await withOpenClawTestState({ applyEnv: false, layout: "state-only" }, async (state) => {
    const scope = { agentId: "main", env: state.env };
    const storeTemplate = state.statePath("agents", "{agentId}", "sessions", "sessions.json");
    const storePath = resolveSessionStorePathCore(storeTemplate, scope);
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const databaseOptions = {
      ...scope,
      path: resolveSqliteTargetFromSessionStorePath(storePath, scope).path,
    };
    openOpenClawAgentDatabase(databaseOptions);
    const runChild = () =>
      runDoctorChild(
        [
          `--max-old-space-size=${CHILD_HEAP_MIB}`,
          ...resolveRuntimeWorkerArgv(child),
          state.stateDir,
          storeTemplate,
        ],
        state.env,
      );

    closeOpenClawAgentDatabasesForTest();
    await expect(runChild()).resolves.toMatchObject({ foundGroups: 0, scannedStores: 1 });
    const writable = openOpenClawAgentDatabase(databaseOptions);
    const seedSql = sessionSqlFixture(writable.db);
    const insertNode = seedSql`INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at, entry_valid) VALUES (?, ?, ?, ?, 1)`;
    const insertWindow = seedSql`INSERT INTO session_windows (session_key, session_id, reason, session_scope, created_at, updated_at, chat_type, model_provider, model, agent_harness_id) VALUES (?, ?, 'initial', 'conversation', ?, ?, 'direct', 'openai', 'gpt-5.5', 'codex')`;
    runSqliteImmediateTransactionSync(writable.db, () => {
      for (let index = 0; index < ROW_COUNT; index += 1) {
        const sessionId = `memory-session-${index.toString().padStart(4, "0")}`;
        const updatedAt = 1_800_000_000_000 + index;
        const entry = {
          sessionId,
          skillsSnapshot: { prompt: payloadFor(index), skills: [] },
          updatedAt,
        };
        insertNode.run(sessionKeyFor(index), sessionId, JSON.stringify(entry), updatedAt);
        insertWindow.run(sessionKeyFor(index), sessionId, updatedAt, updatedAt);
      }
    });
    closeOpenClawAgentDatabasesForTest();

    await expect(runChild()).resolves.toMatchObject({ foundGroups: 0, scannedStores: 1 });
    const { db } = openOpenClawAgentDatabase(databaseOptions);
    const sql = sessionSqlFixture(db);
    expect(
      sql`SELECT (SELECT count(*) FROM session_nodes) AS nodes, (SELECT count(*) FROM session_windows) AS windows, (SELECT count(*) FROM session_nodes WHERE entry_valid <> 1) AS invalid`.get(),
    ).toEqual({ nodes: ROW_COUNT, windows: ROW_COUNT, invalid: 0 });
    for (const index of [0, Math.floor(ROW_COUNT / 2), ROW_COUNT - 1]) {
      expect(
        sql`SELECT json_extract(entry_json, '$.skillsSnapshot.prompt') AS prompt FROM session_nodes WHERE session_key = ${sessionKeyFor(index)}`.get(),
      ).toEqual({ prompt: payloadFor(index) });
    }
  });
}, 90_000);
