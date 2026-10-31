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
    const beforeSettlement = <T>(
      gate: PromiseLike<T>,
      work: PromiseLike<unknown>,
      message: string,
    ) => withinTest(awaitGateBeforeSettlement(gate, work, message), signal);
    const agentId = scenario === "new database" ? "firstbirth-new" : "firstbirth-interrupted";
    const stateDir = resolveStateDir();
    const storeAt = (id: string) => path.join(stateDir, "agents", id, "sessions", "sessions.json");
    const storePath = storeAt(agentId);
    const databaseAt = (root: string) =>
      path.join(root, "agents", agentId, "agent", "openclaw-agent.sqlite");
    const configuredDatabasePath = databaseAt(stateDir);
    const databasePath = databaseAt(await fs.realpath(stateDir));
    testState.sessionStorePath = storeAt("{agentId}");
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
    try {
      await beforeSettlement(
        gate.entered,
        opening,
        "Agent schema creation did not reach its integrity gate",
      );
      // Catalog admission precedes canonical schema creation at this worker gate.
      expect(hasSqliteDatabaseSchemaAdmissionForPath(databasePath)).toBe(true);
      const key = `agent:${agentId}:dashboard:first-birth`;
      observeDiscovery = true;
      const request = {
        type: "req",
        id: "first-birth",
        method: "sessions.create",
        params: { agentId, key },
      };
      creating = onceMessage<CreateSessionReply>(
        ws,
        (response) => response.type === "res" && response.id === request.id,
      );
      ws.send(JSON.stringify(request));
      const observed = await beforeSettlement(
        discovery.promise,
        creating,
        "sessions.create settled without discovering its physical store",
      );
      gate.release();
      await withinTest(opening, signal);
      const result = await withinTest(creating, signal);
      // A second unadmitted path would defer dispatch even without joining schema birth.
      expect(observed.candidates).toEqual([
        { path: configuredDatabasePath, physicalPath: databasePath },
      ]);
      expect(result).toMatchObject({ ok: true, payload: { key, sessionId: expect.any(String) } });
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
      await Promise.allSettled([opening, creating]);
      await nativeWorker.close();
      readCandidates.mockRestore();
      run.mockRestore();
      await closeGatewayTestWebSocket(ws);
    }
  },
);
