import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { threadId } from "node:worker_threads";
import pg from "pg";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { CapturedSessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import {
  installDatabaseProcessRole,
  withEngineStoreAdmission,
} from "../infra/database-engine/admission-scope.js";
import { installDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { resolveDatabaseFamilyEngines } from "../infra/database-engine/registry.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { consultRealtimeVoiceAgent } from "./agent-consult-runtime.js";
import { assertClientVoiceSessionOpen } from "./client-voice-session-read.js";
import { ensureClientVoiceAgentSessionEntry } from "./client-voice-session-write.js";
import { createOrResumeClientVoiceSession } from "./client-voice-session.js";

const engine = process.argv[2];
Error.stackTraceLimit = 30;
assert(engine === "postgres" || engine === "sqlite");
assert.equal(threadId, 0);
const connection = process.env.OPENCLAW_TEST_TALK_ENTRY_PG_CONNECTION;
const stateDir = process.env.OPENCLAW_STATE_DIR;
assert(connection);
assert(stateDir);
installDatabaseProcessRole("gateway");
installDatabaseEngineSelection({
  effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine } }),
  ...(engine === "postgres" ? { postgres: { connection, schemaPrefix: "talk_entry" } } : {}),
});
const config = { agents: { ownership: "explicit" as const, entries: { warm: {}, cold: {} } } };
setRuntimeConfigSnapshot(config);

const agentPaths = ["warm", "cold"].map((agentId) => resolveOpenClawAgentSqlitePath({ agentId }));
try {
  // Bootstrap alone has synchronous admission; the runtime entry writer below does not.
  const state = withEngineStoreAdmission(() => openOpenClawStateDatabase());
  withEngineStoreAdmission(() => {
    const warm = openOpenClawAgentDatabase({ agentId: "warm" });
    closeOpenClawAgentDatabaseByPath(warm.path);
  });
  const assertSqlBoundary = () => {
    const query = () => state.db.prepare("SELECT 1").get();
    if (engine === "postgres") {
      assert.throws(query, /PostgreSQL connections must run in a worker/);
    } else {
      assert.doesNotThrow(query);
    }
  };
  assertSqlBoundary();
  assert.equal(existsSync(resolveOpenClawAgentSqlitePath({ agentId: "cold" })), false);
  for (const agentId of ["warm", "cold"]) {
    const sessionKey = `agent:${agentId}:voice-regression`;
    let committedSource: CapturedSessionEntryReadSource | undefined;
    const sessionId = await ensureClientVoiceAgentSessionEntry({
      agentId,
      sessionKey,
      onCommittedSource: (source, entry) => {
        assert.equal(typeof entry.sessionId, "string");
        committedSource = source;
      },
    });
    assert(
      committedSource,
      "entry identity and physical source must publish before startup returns",
    );
    assert.equal(committedSource.agentId, agentId);
    assert.equal(
      (await readSessionEntryReadOnlyInWorker({ agentId, sessionKey }))?.sessionId,
      sessionId,
    );
    assert.equal(await ensureClientVoiceAgentSessionEntry({ agentId, sessionKey }), sessionId);
    const voiceSessionId = await createOrResumeClientVoiceSession({
      agentId,
      sessionKey,
      origin: "client",
      transcriptCapable: true,
    });
    assert.equal(
      await assertClientVoiceSessionOpen({ agentId, sessionKey, voiceSessionId }),
      "client",
    );
    const runs: Array<{ sessionId: string; sessionKey?: string }> = [];
    const result = await consultRealtimeVoiceAgent({
      cfg: config,
      agentRuntime: {
        ...createPluginRuntime().agent,
        runEmbeddedAgent: async (request) => {
          runs.push({ sessionId: request.sessionId, sessionKey: request.sessionKey });
          return { payloads: [{ text: "Consult answered." }], meta: { durationMs: 1 } };
        },
      },
      logger: { warn: (message) => assert.fail(message) },
      agentId,
      sessionKey,
      messageProvider: "webchat",
      lane: "talk",
      runIdPrefix: "talk-consult-regression",
      args: { question: "What is on my calendar?" },
      transcript: [{ role: "user", text: "What is on my calendar?" }],
      surface: "a browser Talk session",
      userLabel: "User",
    });
    assert.deepEqual(result, { text: "Consult answered." });
    assert.deepEqual(runs, [{ sessionId, sessionKey }]);
    assertSqlBoundary();
  }
  console.log(`Talk entry initialization passed on the Gateway thread: ${engine}`);
} finally {
  await cleanupSessionStateForTest({ stateDir });
  if (engine === "postgres") {
    const client = new pg.Client({ connectionString: connection });
    await client.connect();
    try {
      for (const pathname of [resolveOpenClawStateSqlitePath(), ...agentPaths]) {
        if (!existsSync(pathname)) {
          continue;
        }
        using anchor = openNodeSqliteDatabase(pathname, { readOnly: true });
        const row = anchor.prepare("SELECT schema FROM openclaw_engine_anchor").get();
        if (typeof row?.schema === "string") {
          await client.query(
            `DROP SCHEMA IF EXISTS ${client.escapeIdentifier(row.schema)} CASCADE`,
          );
        }
      }
    } finally {
      await client.end();
    }
  }
}
