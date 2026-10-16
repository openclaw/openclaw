import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { closeGatewayTestWebSocket } from "../../test/helpers/gateway-websocket.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { createWorkerSqliteIntegrityGate } from "../config/sessions/session-accessor.sqlite-integrity-counter.test-support.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import * as sessionReaders from "../config/sessions/session-transcript-worker-resources.js";
import { resolveStateDir } from "../config/state-dir.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { hasSqliteDatabaseSchemaAdmissionForPath } from "../infra/sqlite-database-admission.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { openOpenClawAgentSqliteWorkerStoreV2 } from "../state/openclaw-agent-worker-store.js";
import { agentWorkerStoreFixtureEntrypoint } from "../state/openclaw-agent-worker-store.runtime.test-support.js";
import type { AgentWorkerFixtureOperations } from "../state/openclaw-agent-worker-store.test-support.js";
import { setupSessionCreateTestHarness } from "./server.sessions.create.test-support.js";
import { loadGatewayTestConfig } from "./test-helpers.config-runtime.js";
import { onceMessage, type rpcReq, testState } from "./test-helpers.js";

const worker = vi.hoisted(() => ({
  gate: undefined as ReturnType<typeof createWorkerSqliteIntegrityGate> | undefined,
}));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  const { observeWorkerSqliteIntegrity } =
    await import("../config/sessions/session-accessor.sqlite-integrity-counter.test-support.js");
  return {
    ...actual,
    Worker: observeWorkerSqliteIntegrity(actual.Worker, () => worker.gate),
  };
});

worker.gate = createWorkerSqliteIntegrityGate();
const { openClient } = setupSessionCreateTestHarness();
type CreateSessionReply = Awaited<ReturnType<typeof rpcReq<{ key: string; sessionId: string }>>>;

test.for(["new database", "interrupted empty database"])(
  "sessions.create joins canonical schema birth for %s",
  async (scenario, { signal }) => {
    const agentId = scenario === "new database" ? "firstbirth-new" : "firstbirth-interrupted";
    const stateDir = resolveStateDir();
    const storePath = path.join(stateDir, "agents", agentId, "sessions", "sessions.json");
    const configuredDatabasePath = path.join(
      stateDir,
      "agents",
      agentId,
      "agent",
      "openclaw-agent.sqlite",
    );
    const databasePath = path.join(
      await fs.realpath(stateDir),
      "agents",
      agentId,
      "agent",
      "openclaw-agent.sqlite",
    );
    testState.sessionStorePath = path.join(
      stateDir,
      "agents",
      "{agentId}",
      "sessions",
      "sessions.json",
    );
    testState.agentsConfig = { ownership: "explicit", entries: { main: {}, [agentId]: {} } };
    setRuntimeConfigSnapshot(loadGatewayTestConfig());
    const { ws } = await openClient();
    if (scenario === "interrupted empty database") {
      await fs.mkdir(path.dirname(databasePath), { recursive: true });
      await fs.writeFile(databasePath, "");
    }

    const gate = worker.gate!;
    gate.arm(databasePath);
    const nativeWorker = await openOpenClawAgentSqliteWorkerStoreV2<AgentWorkerFixtureOperations>(
      { agentId, path: databasePath },
      { version: 2, assertCurrent() {} },
      { moduleUrl: resolveRuntimeWorkerUrl(agentWorkerStoreFixtureEntrypoint), input: undefined },
    );
    const opening =
      scenario === "new database"
        ? nativeWorker.prepare()
        : nativeWorker
            .execute({ type: "inspect", input: "wal_autocheckpoint" }, () => {})
            .then(() => {});
    const discovery = createDeferred<{
      candidates: Parameters<typeof sessionReaders.withSessionHistoryWorkerReadCandidates>[0];
      dispatched: number;
    }>();
    let observeDiscovery = false;
    const run = vi.spyOn(sessionReaders.targetDiscoveryLane.pool, "run");
    const original = sessionReaders.withSessionHistoryWorkerReadCandidates;
    const readCandidates = vi
      .spyOn(sessionReaders, "withSessionHistoryWorkerReadCandidates")
      .mockImplementation((candidates, operation, lane, requestSignal) => {
        const observe =
          observeDiscovery &&
          lane === sessionReaders.targetDiscoveryLane &&
          candidates.some((candidate) => candidate.physicalPath === databasePath);
        return original(
          candidates,
          (scope) =>
            operation({
              ...scope,
              readTargetInventory(request) {
                const before = run.mock.calls.length;
                const result = scope.readTargetInventory(request);
                if (observe) {
                  discovery.resolve({ candidates, dispatched: run.mock.calls.length - before });
                }
                return result;
              },
            }),
          lane,
          requestSignal,
        );
      });
    let creating: Promise<CreateSessionReply> | undefined;
    let cancelledBorrower: ReturnType<typeof captureOpenClawAgentDatabaseExecution> | undefined;
    let cancelledPreparation: Promise<void> | undefined;
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          gate.entered,
          opening,
          "Agent schema creation did not reach its integrity gate",
        ),
        signal,
      );
      // Catalog admission precedes canonical schema creation at this worker gate.
      expect(hasSqliteDatabaseSchemaAdmissionForPath(databasePath)).toBe(true);
      if (scenario === "interrupted empty database") {
        // One caller's cancellation must not release discovery while another births the schema.
        cancelledBorrower = captureOpenClawAgentDatabaseExecution({ agentId, path: databasePath });
        const cancellation = new AbortController();
        const reason = new Error("Cancel the second preparation");
        cancelledPreparation = cancelledBorrower.prepare(
          {
            assertCurrent() {},
            createAdmission(binding) {
              return () => ({
                nativeLocations: binding.nativeLocations,
                admission: createSqliteWorkerOperationAdmission((request, grant) => {
                  binding.authorize(request);
                  if (!grant()) {
                    throw new Error("Preparation fixture lost admission");
                  }
                }, binding.attachment),
              });
            },
          },
          cancellation.signal,
        );
        cancellation.abort(reason);
        await expect(withinTest(cancelledPreparation, signal)).rejects.toBe(reason);
      }
      const key = `agent:${agentId}:dashboard:first-birth`;
      observeDiscovery = true;
      const requestId = "first-birth";
      creating = onceMessage<CreateSessionReply>(
        ws,
        (response) => response.type === "res" && response.id === requestId,
      );
      ws.send(
        JSON.stringify({
          type: "req",
          id: requestId,
          method: "sessions.create",
          params: { agentId, key },
        }),
      );
      const observed = await withinTest(
        awaitGateBeforeSettlement(
          discovery.promise,
          creating,
          "sessions.create settled without discovering its physical store",
        ),
        signal,
      );
      gate.release();
      await withinTest(opening, signal);
      const result = await withinTest(creating, signal);
      const diagnostic = JSON.stringify(result).replace("SessionStoreUnavailableError: ", "");
      // A second unadmitted path would defer dispatch even without joining schema birth.
      expect(observed.candidates).toEqual([
        { path: configuredDatabasePath, physicalPath: databasePath },
      ]);
      expect(result, diagnostic).toMatchObject({
        ok: true,
        payload: { key, sessionId: expect.any(String) },
      });
      expect(observed.dispatched, "Discovery must wait for the canonical agent schema").toBe(0);
      expect(result.payload?.sessionId).toBeTruthy();
      const entry = await readSessionEntryReadOnlyInWorker({
        agentId,
        storePath,
        sessionKey: key,
        projection: "full",
      });
      expect(entry?.sessionId).toBe(result.payload?.sessionId);
    } finally {
      gate.release();
      await Promise.allSettled([opening, creating, cancelledPreparation]);
      await cancelledBorrower?.release();
      await nativeWorker.close();
      readCandidates.mockRestore();
      run.mockRestore();
      await closeGatewayTestWebSocket(ws);
    }
  },
);
