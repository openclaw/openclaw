import assert from "node:assert/strict";
import { once } from "node:events";
import { isMainThread, MessageChannel } from "node:worker_threads";
import { onInternalDiagnosticEvent } from "../infra/diagnostic-events.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { setLoggerOverride } from "../logging/logger.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-contract.js";
import { createAgentDatabaseNativeGeneration } from "./openclaw-agent-execution-native.js";
import { startOpenClawDatabaseIntegrityVerifier } from "./openclaw-database-verify.js";
import { readOpenClawAgentIntegrityVerification } from "./openclaw-quarantine-store.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

assert.equal(isMainThread, true, "Broker admission must run on the real host thread");
await withOpenClawTestState(
  { label: "database-verifier-worker-relay" },
  async ({ env, statePath }) => {
    setLoggerOverride({ level: "info", file: statePath("verify.log"), consoleLevel: "silent" });
    const agent = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    // Simulate a restart: retain the clean receipt without the initializer's runtime proof.
    closeOpenClawAgentDatabasesForTest();
    const before = readOpenClawAgentIntegrityVerification(agent.path, env);
    assert.equal(before?.clean_close, 1);
    assert.ok(before);

    // The real Gateway keeps a listener alive; its verifier timer is deliberately unref'd.
    const { port1, port2 } = new MessageChannel();
    const verified = once(port1, "message");
    const unsubscribe = onInternalDiagnosticEvent(
      (event) => {
        if (
          event.type === "log.record" &&
          event.attributes?.subsystem === "state/database-verify" &&
          event.message === "database integrity verification passed" &&
          event.attributes?.path === agent.path
        ) {
          port2.postMessage(null);
        }
      },
      { include: ["log.record"] },
    );
    const verifier = startOpenClawDatabaseIntegrityVerifier({ env });
    const context = captureOpenClawStateWorkerContext({ env });
    const generation = createAgentDatabaseNativeGeneration(
      agent.agentId,
      agent.path,
      context,
      context.admission.assertCurrent,
      context.admission.assertCurrent,
      undefined,
      () => {},
    );
    const source: AgentDatabaseRequestExecutionSource = {
      assertCurrent: context.admission.assertCurrent,
      createAdmission(binding) {
        return () => ({
          nativeLocations: binding.nativeLocations,
          admission: createSqliteWorkerOperationAdmission((request, grant) => {
            binding.authorize(request);
            context.admission.assertCurrent();
            assert.ok(grant(), "Synthetic database admission expired");
          }),
        });
      },
    };
    try {
      await generation.run(source, (scope) =>
        scope.execute({ type: "database.prepareWrite", input: undefined }),
      );
      await verified;
      assert.deepEqual(
        { ...readOpenClawAgentIntegrityVerification(agent.path, env) },
        {
          ...before,
          clean_close: 0,
        },
      );
    } finally {
      await verifier.stop();
      await generation.close();
      await drainGlobalSingletonLifecycleState();
      unsubscribe();
      port1.close();
      port2.close();
      setLoggerOverride(null);
    }
  },
);
