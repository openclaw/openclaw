import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { isMainThread } from "node:worker_threads";
import { onInternalDiagnosticEvent } from "../infra/diagnostic-events.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { setLoggerOverride } from "../logging/logger.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  closeOpenClawAgentDatabaseByPath,
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
    closeOpenClawAgentDatabaseByPath(agent.path);
    const before = readOpenClawAgentIntegrityVerification(agent.path, env);
    assert.equal(before?.clean_close, 1);
    assert.ok(before);

    let verified = false;
    const unsubscribe = onInternalDiagnosticEvent(
      (event) => {
        if (
          event.type === "log.record" &&
          event.attributes?.subsystem === "state/database-verify" &&
          event.message === "database integrity verification passed" &&
          event.attributes?.path === agent.path
        ) {
          verified = true;
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
      await generation.runExisting(source, (scope) =>
        scope.execute({ type: "database.prepareWrite", input: undefined }),
      );
      const deadline = performance.now() + 20_000;
      for (;;) {
        if (verified) {
          break;
        }
        assert.ok(
          performance.now() < deadline,
          "Cached Worker open never completed its quick check",
        );
        await delay(20);
      }
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
      setLoggerOverride(null);
    }
  },
);
