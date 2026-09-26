import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../../infra/agent-events.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "../../infra/node-sqlite.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import type { SqliteWorkerNativeSettlementOwner } from "../../infra/sqlite-worker-operation-settlement.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { prepareTaskRegistryRead } from "../../tasks/task-registry-read.js";
import { getTaskRegistryStore } from "../../tasks/task-registry.store.js";
import { loadTaskRegistryStateFromSqliteReadOnly } from "../../tasks/task-registry.store.sqlite.js";
import { createTaskFixture } from "../../tasks/task-registry.test-support.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "../../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { holdStateDatabaseWriteTransaction } from "../../test-utils/state-database-contention.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodRegistry,
} from "../methods/registry.js";
import { coreGatewayHandlers, handleGatewayRequest } from "../server-methods.js";
import { rolePolicyConfig } from "../session-sharing.test-utils.js";
import * as artifactSessionResolution from "./artifacts-session-resolution.js";
import { assistantFileMessage } from "./artifacts.test-support.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetAgentEventsForTest({ preserveListeners: true });
  resetGatewayWorkAdmission();
});

const methods = ["artifacts.list", "artifacts.get", "artifacts.download"] as const;
const methodRegistry = createGatewayMethodRegistry(
  createCoreGatewayMethodDescriptors(coreGatewayHandlers),
);
const client: GatewayClient = {
  connId: "artifact-task-read",
  connect: {
    minProtocol: 1,
    maxProtocol: 1,
    client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
    role: "operator",
    scopes: ["operator.read"],
  },
};

async function request(
  method: (typeof methods)[number],
  params: Record<string, unknown>,
  getRuntimeConfig: () => OpenClawConfig = () => ({}),
) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: { type: "req", id: method, method, params },
    client,
    context: { getRuntimeConfig } as GatewayRequestContext,
    methodRegistry,
    isWebchatConnect: () => false,
    respond,
  });
  return respond;
}

async function fixture() {
  const scope = {
    agentId: "main",
    sessionKey: "agent:main:artifact-task-read",
    sessionId: "artifact-task-read",
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const task = createTaskFixture("cli", {
    runId: "artifact-task-read",
    requesterSessionKey: scope.sessionKey,
    ownerKey: scope.sessionKey,
    task: "Read the accepted artifact task",
    notifyPolicy: "silent",
    deliveryStatus: "not_applicable",
  });
  await appendTranscriptMessage(scope, {
    message: assistantFileMessage({ title: "result.txt", taskId: task.taskId }),
  });
  const listed = await request("artifacts.list", { sessionKey: scope.sessionKey });
  expect(listed.mock.calls[0]?.[0]).toBe(true);
  const artifactId: unknown = listed.mock.calls[0]?.[1]?.artifacts?.[0]?.id;
  if (typeof artifactId !== "string") {
    throw new Error("Expected the real transcript artifact");
  }
  await prepareTaskRegistryRead();
  return { task, artifactId };
}

function observeHostSql() {
  const native = requireNodeSqlite();
  const originalConstructor = native.DatabaseSync;
  let opens = 0;
  native.DatabaseSync = new Proxy(originalConstructor, {
    construct(target, args, newTarget) {
      opens += 1;
      return Reflect.construct(target, args, newTarget);
    },
  });
  const calls = {
    prepare: vi.spyOn(native.DatabaseSync.prototype, "prepare"),
    exec: vi.spyOn(native.DatabaseSync.prototype, "exec"),
    close: vi.spyOn(native.DatabaseSync.prototype, "close"),
    get: vi.spyOn(native.StatementSync.prototype, "get"),
    all: vi.spyOn(native.StatementSync.prototype, "all"),
    run: vi.spyOn(native.StatementSync.prototype, "run"),
    iterate: vi.spyOn(native.StatementSync.prototype, "iterate"),
  };
  const restore = () => {
    native.DatabaseSync = originalConstructor;
    for (const call of Object.values(calls)) {
      call.mockRestore();
    }
  };
  try {
    const calibration = openNodeSqliteDatabase(":memory:");
    try {
      calibration.exec("SELECT 1");
      const statement = calibration.prepare("SELECT 1 AS value");
      statement.get();
      statement.all();
      statement.run();
      expect([...statement.iterate()]).toEqual([{ value: 1 }]);
    } finally {
      calibration.close();
    }
    expect(opens).toBe(1);
    for (const call of Object.values(calls)) {
      expect(call).toHaveBeenCalled();
      call.mockClear();
    }
    opens = 0;
  } catch (error) {
    restore();
    throw error;
  }
  return {
    counts: () => ({
      open: opens,
      ...Object.fromEntries(
        Object.entries(calls).map(([key, call]) => [key, call.mock.calls.length]),
      ),
    }),
    execSql: () => calls.exec.mock.calls.map(([sql]) => sql),
    reset() {
      opens = 0;
      for (const call of Object.values(calls)) {
        call.mockClear();
      }
    },
    restore,
  };
}

describe("registered artifact task reads", () => {
  it.each(methods)(
    "keeps %s responsive while accepted task events await custody",
    async (method) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const { task, artifactId } = await fixture();
        await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        const context = captureOpenClawStateWorkerContext();
        const holder = holdStateDatabaseWriteTransaction(context.admission.databasePath, 300);
        let pending: ReturnType<typeof request> | undefined;
        let observation: ReturnType<typeof observeHostSql> | undefined;
        try {
          await holder.ready;
          observation = observeHostSql();
          const started = performance.now();
          const timer = sleep(10).then(() => Atomics.load(holder.released, 0));
          emitAgentEvent({
            runId: task.runId!,
            stream: "tool",
            data: { phase: "start", name: "accepted" },
          });
          pending = request(method, {
            taskId: task.taskId,
            ...(method === "artifacts.list" ? {} : { artifactId }),
          });
          const releasedAtTimer = await timer;
          const heldSql = observation.counts();
          console.info("Artifact task custody observation", { method, releasedAtTimer, heldSql });
          expect(releasedAtTimer).toBe(0);
          expect(Object.values(heldSql)).toEqual(Array(8).fill(0));
          holder.release();
          expect(await holder.joined).toBe(0);
          const response = await pending;
          expect(response.mock.calls[0]?.[0]).toBe(true);
          const expected = { id: artifactId, taskId: task.taskId, title: "result.txt" };
          expect(response.mock.calls[0]?.[1]).toMatchObject(
            method === "artifacts.list"
              ? { artifacts: [expected] }
              : {
                  artifact: expected,
                  ...(method === "artifacts.download"
                    ? { encoding: "base64", data: "aGVsbG8=" }
                    : {}),
                },
          );
          console.info("Artifact task completed observation", {
            method,
            elapsedMs: performance.now() - started,
            hostSql: observation.counts(),
          });
        } finally {
          observation?.restore();
          holder.release();
          await holder.joined;
          await pending;
          await closeOpenClawStateDatabaseAsync();
        }
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)).toMatchObject({
          toolUseCount: 1,
          lastToolName: "accepted",
        });
      });
    },
  );

  it.each(methods)("uses the current default agent after preparing %s", async (method) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      let config: OpenClawConfig = {
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      };
      await state.writeConfig(config);
      for (const agentId of ["main", "work"]) {
        const scope = {
          agentId,
          sessionKey: `agent:${agentId}:main`,
          sessionId: `artifact-${agentId}`,
        };
        await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
        await appendTranscriptMessage(scope, {
          message: assistantFileMessage({ title: `${agentId}.txt` }),
        });
      }
      const listed = await request(
        "artifacts.list",
        { sessionKey: "agent:work:main" },
        () => config,
      );
      expect(listed.mock.calls[0]?.[0]).toBe(true);
      const artifactId: unknown = listed.mock.calls[0]?.[1]?.artifacts?.[0]?.id;
      if (typeof artifactId !== "string") {
        throw new Error("Expected the work agent artifact");
      }
      const prepare = artifactSessionResolution.prepareArtifactSessionResolution;
      vi.spyOn(artifactSessionResolution, "prepareArtifactSessionResolution").mockImplementation(
        async (query) => {
          const resolve = await prepare(query);
          config = { agents: { list: [{ id: "main" }, { id: "work", default: true }] } };
          return resolve;
        },
      );
      const response = await request(
        method,
        {
          sessionKey: "main",
          ...(method === "artifacts.list" ? {} : { artifactId }),
        },
        () => config,
      );
      expect(response.mock.calls[0]?.[0]).toBe(true);
      const expected = { id: artifactId, sessionKey: "agent:work:main", title: "work.txt" };
      expect(response.mock.calls[0]?.[1]).toMatchObject(
        method === "artifacts.list" ? { artifacts: [expected] } : { artifact: expected },
      );
    });
  });

  it.each([
    { method: "artifacts.list", outcome: "completed" },
    { method: "artifacts.get", outcome: "lost result" },
    { method: "artifacts.download", outcome: "unknown settlement" },
    { method: "artifacts.download", outcome: "replaced config" },
    { method: "artifacts.list", outcome: "retired database" },
  ] as const)(
    "awaits granted task publication for $method with $outcome",
    async ({ method, outcome }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const { task, artifactId } = await fixture();
        const store = getTaskRegistryStore();
        const mutate = store.runAgentEventMutationAsync.bind(store);
        const committed = createDeferred();
        const release = createDeferred();
        let nativeOwner: SqliteWorkerNativeSettlementOwner | undefined;
        let config: OpenClawConfig = {};
        let pending: ReturnType<typeof request> | undefined;
        let result:
          | Promise<PromiseSettledResult<Awaited<ReturnType<typeof request>>>[]>
          | undefined;
        let responded = false;
        let closing: Promise<void> | undefined;
        const observation = observeHostSql();
        let submissionSql = observation.counts();
        let submissionExec: string[] = [];
        const writes = vi
          .spyOn(store, "runAgentEventMutationAsync")
          .mockImplementation(async (context, input, assertCurrent, onGranted) => {
            const receipt = await mutate(context, input, assertCurrent, (owner) => {
              nativeOwner = owner;
              onGranted(
                outcome === "unknown settlement"
                  ? {
                      get committed() {
                        return owner.committed;
                      },
                      get settlement() {
                        const settled = owner.settlement;
                        return settled ? { ...settled, kind: "unknown" as const } : settled;
                      },
                      waitForSettlement() {
                        throw new SqliteWorkerError(
                          "Synthetic unknown settlement",
                          "outcome-unknown",
                        );
                      },
                    }
                  : owner,
              );
              submissionSql = observation.counts();
              submissionExec = observation.execSql();
              // Separate the event submission from the actual registered RPC below.
              observation.reset();
              pending = request(
                method,
                {
                  taskId: task.taskId,
                  ...(method === "artifacts.list" ? {} : { artifactId }),
                },
                () => config,
              );
              result = Promise.allSettled([pending]).then((values) => {
                responded = true;
                return values;
              });
            });
            committed.resolve();
            // The real worker has settled; the accepted event still owns publication.
            await release.promise;
            if (outcome === "lost result" || outcome === "unknown settlement") {
              throw new SqliteWorkerError("Synthetic lost task result", "outcome-unknown");
            }
            return receipt;
          });
        try {
          emitAgentEvent({
            runId: task.runId!,
            stream: "tool",
            data: { phase: "start", name: "granted" },
          });
          await committed.promise;
          expect(nativeOwner?.settlement?.kind).toBe("completed");
          expect(nativeOwner?.committed?.facts).toBeDefined();
          await sleep(10);
          expect(responded).toBe(false);
          console.info("Artifact task granted-publication observation", {
            method,
            outcome,
            nativeSettlement: nativeOwner?.settlement?.kind,
            responsePending: !responded,
            submissionSql,
            submissionExec,
            hostSql: observation.counts(),
          });
          expect(Object.values(observation.counts())).toEqual(Array(8).fill(0));
          observation.restore();
          if (outcome === "replaced config") {
            config = rolePolicyConfig();
          } else if (outcome === "retired database") {
            closing = closeOpenClawStateDatabaseAsync();
          }
          release.resolve();
          const settled = await result;
          expect(writes).toHaveBeenCalledOnce();
          if (outcome === "completed") {
            expect(settled?.[0]).toMatchObject({ status: "fulfilled" });
            expect((await pending)?.mock.calls[0]?.[0]).toBe(true);
          } else if (outcome === "replaced config") {
            expect(settled?.[0]).toMatchObject({ status: "fulfilled" });
            expect((await pending)?.mock.calls[0]).toMatchObject([
              false,
              undefined,
              { code: "INVALID_REQUEST", details: { type: "artifact_scope_not_found" } },
            ]);
          } else if (outcome === "lost result" || outcome === "unknown settlement") {
            expect(settled?.[0]).toMatchObject({
              status: "rejected",
              reason: { code: "outcome-unknown", message: "Synthetic lost task result" },
            });
          } else {
            expect(settled?.[0]).toMatchObject({
              status: "rejected",
              reason: { code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED" },
            });
          }
          await closing;
          expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)).toMatchObject({
            toolUseCount: 1,
            lastToolName: "granted",
          });
        } finally {
          observation.restore();
          release.resolve();
          await result;
          await closing;
          await closeOpenClawStateDatabaseAsync();
        }
        expect(getActiveGatewayRootWorkCount()).toBe(0);
      });
    },
  );
});
