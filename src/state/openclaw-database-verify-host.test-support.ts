import assert from "node:assert/strict";
import { once } from "node:events";
import { isMainThread, MessageChannel } from "node:worker_threads";
import { onInternalDiagnosticEvent } from "../infra/diagnostic-events.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  readSqliteDatabaseCleanClose,
  readSqliteDatabaseIntegrityVerification,
} from "../infra/sqlite-database-admission.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { setLoggerOverride } from "../logging/logger.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-admission-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import {
  requestOpenClawAgentDatabaseIntegrityCheck,
  startOpenClawDatabaseIntegrityVerifier,
} from "./openclaw-database-verify.js";
import { readOpenClawDatabaseQuarantineFailure } from "./openclaw-quarantine-store.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

assert.equal(isMainThread, true, "Broker admission must run on the real host thread");
await withOpenClawTestState(
  { label: "database-verifier-worker-relay" },
  async ({ env, statePath }) => {
    setLoggerOverride({ level: "info", file: statePath("verify.log"), consoleLevel: "silent" });
    const agent = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    closeOpenClawAgentDatabaseByPath(agent.path);
    const before = readSqliteDatabaseIntegrityVerification(agent.path);
    assert.equal(readSqliteDatabaseCleanClose(agent.path), true);
    assert.ok(before);

    // The real Gateway keeps a listener alive; its verifier timer is deliberately unref'd.
    const { port1, port2 } = new MessageChannel();
    const verified = once(port1, "message");
    const unsubscribe = onInternalDiagnosticEvent(
      (event) => {
        if (
          event.type === "log.record" &&
          event.attributes?.subsystem === "state/database-verify" &&
          (event.message === "database integrity verification passed" ||
            event.message === "database integrity verification failed") &&
          event.attributes?.path === agent.path
        ) {
          port2.postMessage(event.message);
        }
      },
      { include: ["log.record"] },
    );
    const verifier = startOpenClawDatabaseIntegrityVerifier({ env });
    const context = captureOpenClawStateWorkerContext({ env });
    const execution = captureOpenClawAgentDatabaseExecution({ agentId: agent.agentId, env });
    const source: AgentDatabaseRequestExecutionSource = {
      assertCurrent: context.admission.assertCurrent,
      createAdmission(binding) {
        return () => ({
          nativeLocations: binding.nativeLocations,
          admission: createSqliteWorkerOperationAdmission((request, grant) => {
            binding.authorize(request);
            context.admission.assertCurrent();
            assert.ok(grant(), "Synthetic database admission expired");
          }, binding.attachment),
        });
      },
    };
    try {
      await execution.runExisting(source, (scope) =>
        scope.execute({ type: "database.prepareWrite", input: undefined }),
      );
      requestOpenClawAgentDatabaseIntegrityCheck({ env, path: agent.path, check: "quick" });
      await verified;
      assert.deepEqual(readSqliteDatabaseIntegrityVerification(agent.path), before);
      const database = new (requireNodeSqlite().DatabaseSync)(agent.path);
      try {
        database.exec(`
          CREATE TABLE deferred_parent (id INTEGER PRIMARY KEY);
          CREATE TABLE deferred_child (parent_id INTEGER REFERENCES deferred_parent(id));
          PRAGMA foreign_keys = OFF;
          INSERT INTO deferred_child VALUES (123);
        `);
      } finally {
        database.close();
      }
      const failed = once(port1, "message");
      requestOpenClawAgentDatabaseIntegrityCheck({ env, path: agent.path, check: "full" });
      assert.deepEqual(await failed, ["database integrity verification failed"]);
      assert.equal(
        readOpenClawDatabaseQuarantineFailure("agent", agent.path, { env })?.name,
        "SqliteIntegrityError",
      );
      await assert.rejects(
        execution.runExisting(source, (scope) =>
          scope.execute({ type: "database.prepareWrite", input: undefined }),
        ),
      );
      assert.throws(() => openOpenClawAgentDatabase({ agentId: "worker-1", env }), {
        name: "SqliteIntegrityError",
      });
    } finally {
      await verifier.stop();
      await execution.release();
      await drainGlobalSingletonLifecycleState();
      unsubscribe();
      port1.close();
      port2.close();
      setLoggerOverride(null);
    }
  },
);
