import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import path from "node:path";
import { threadId } from "node:worker_threads";
import {
  buildWatchedSessionsPromptLines,
  prepareWatchedSessionsPromptAsync,
} from "../../agents/watched-sessions-prompt.js";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { publishSystemEventStoreConfig } from "../../config/sessions/session-store-path.js";
import { installGatewayDatabaseEngine } from "../../gateway/server-database-engine.js";
import {
  handleSessionStateSessionReset,
  registerMainSessionGroupWatch,
} from "../../sessions/session-state-events.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { closePostgresPool } from "../postgres-sync/pool.js";
import { isPostgresSqlConnection } from "../sql-connection.js";
import {
  getDatabaseProcessRole,
  installDatabaseProcessRole,
  withEngineStoreAdmission,
} from "./admission-scope.js";

// The restriction checks threadId, so a Worker would silently bypass this proof.
async function probeMain({ stateDir }: { stateDir: string }) {
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
  const statements = channel("openclaw.database.statement");
  let hostStatements = 0;
  const observe = (message: unknown) => {
    if ((message as { engine: string }).engine === "postgres") {
      hostStatements++;
    }
  };
  let result: object;
  try {
    assert.equal(threadId, 0);
    installDatabaseProcessRole("gateway");
    await installGatewayDatabaseEngine();
    // Gateway startup publishes config and its store resolver before session producers run.
    const config = await captureRuntimeConfigAsyncReader()();
    publishSystemEventStoreConfig(config);
    const sessionKey = "agent:main:telegram:group:watched";
    const watcher = "agent:main:main";
    assert.equal(await registerMainSessionGroupWatch({ sessionKey, agentId: "main" }), true);
    await upsertSessionEntryCore(
      { sessionKey },
      { sessionId: "watched-session", displayName: "Watched room", updatedAt: 1 },
    );
    const stores = withEngineStoreAdmission(() => ({
      state: openOpenClawStateDatabase().db,
      agent: openOpenClawAgentDatabase({ agentId: "main" }).db,
    }));

    statements.subscribe(observe);
    // A real admitted query proves the observer sees host SQL before counting the async path.
    const probe = stores.state.prepare("SELECT 7 AS value");
    withEngineStoreAdmission(() => assert.equal(probe.get()?.value, 7));
    const admittedStatements = hostStatements;
    assert.throws(() => probe.get(), /PostgreSQL connections must run in a worker/);
    hostStatements = 0;
    const input = {
      enabled: true,
      sessionKey: watcher,
      toolNames: ["sessions_history"],
      assertCurrent() {},
    };
    const prepared = await prepareWatchedSessionsPromptAsync(input);
    await handleSessionStateSessionReset(watcher);
    const afterRemoval = await prepareWatchedSessionsPromptAsync(input);
    const emptySnapshot = await prepareWatchedSessionsPromptAsync({
      ...input,
      includeEmptySnapshot: true,
    });
    result = {
      threadId,
      role: getDatabaseProcessRole(),
      statePostgres: isPostgresSqlConnection(stores.state),
      agentPostgres: isPostgresSqlConnection(stores.agent),
      admittedStatements,
      hostStatements,
      prepared,
      promptLines: buildWatchedSessionsPromptLines(prepared),
      afterRemoval: afterRemoval ?? null,
      emptySnapshot,
    };
  } catch (error) {
    result = { error: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  } finally {
    statements.unsubscribe(observe);
    await cleanupSessionStateForTest({ stateDir });
    await closePostgresPool();
  }
  process.send?.(result);
  process.disconnect?.();
}

process.once("message", (input: { stateDir: string }) => {
  void probeMain(input);
});
