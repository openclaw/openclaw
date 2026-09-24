import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observeDeviceAuthHostSql } from "../infra/device-auth-store.sql.test-support.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { ensureTaskFlowRegistryReadyAsync, readResidentTaskFlow } from "./task-flow-registry.js";
import { getTaskFlowRegistryStore } from "./task-flow-registry.store.js";
import {
  loadTaskFlowRegistryStateFromSqliteReadOnly,
  upsertTaskFlowRegistryRecordToSqlite,
} from "./task-flow-registry.store.sqlite.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import { publishTaskRecordAfterAtomicStore } from "./task-registry-publication.js";
import { markTaskTerminalById } from "./task-registry-record-api.js";
import { ensureTaskRegistryReadyAsync } from "./task-registry-state.js";
import { upsertTaskWithDeliveryStateToSqlite } from "./task-registry.store.sqlite.js";
import type { TaskRecord } from "./task-registry.types.js";
import { resolveTaskCleanupAfter } from "./task-retention.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only", prefix: "live-flow-worker-" });
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  await state.cleanup();
});

it("retries the live equal-time winner through the worker and canonical close", async () => {
  const flowId = "worker-live-flow";
  const task: TaskRecord = {
    taskId: "worker-live-a",
    runtime: "cli",
    ownerKey: "agent:main:live",
    requesterSessionKey: "agent:main:live",
    parentFlowId: flowId,
    scopeKind: "session",
    task: "Live insertion winner",
    status: "succeeded",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    createdAt: 10,
    lastEventAt: 20,
    endedAt: 20,
  };
  task.cleanupAfter = resolveTaskCleanupAfter(task);
  const flow: TaskFlowRecord = {
    flowId,
    syncMode: "task_mirrored",
    ownerKey: task.ownerKey,
    goal: "Stale worker flow",
    revision: 4,
    status: "running",
    notifyPolicy: "silent",
    createdAt: 10,
    updatedAt: 10,
  };
  const native = requireNodeSqlite();
  const prepare = vi.spyOn(native.DatabaseSync.prototype, "prepare");
  const exec = vi.spyOn(native.DatabaseSync.prototype, "exec");
  const statements = (["iterate", "get", "all", "run"] as const).map((method) =>
    vi.spyOn(native.StatementSync.prototype, method),
  );
  const counters = [prepare, exec, ...statements];
  const statementSql = new WeakMap<object, string>();
  const rememberPreparedSql = () => {
    for (const [index, [sql]] of prepare.mock.calls.entries()) {
      const result = prepare.mock.results[index];
      if (result?.type === "return") {
        statementSql.set(result.value, sql);
      }
    }
  };
  upsertTaskFlowRegistryRecordToSqlite(flow);
  upsertTaskWithDeliveryStateToSqlite({ task });
  upsertTaskWithDeliveryStateToSqlite({
    task: { ...task, taskId: "worker-live-b", task: "Durable insertion winner" },
  });
  const context = captureOpenClawStateWorkerContext();
  await ensureTaskRegistryReadyAsync(context);
  await ensureTaskFlowRegistryReadyAsync(context);
  upsertTaskWithDeliveryStateToSqlite({ task });
  publishTaskRecordAfterAtomicStore(task);
  vi.spyOn(getTaskFlowRegistryStore(), "syncMirroredTask").mockImplementationOnce(() => {
    throw new Error("Controlled initial flow refusal");
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  expect(
    markTaskTerminalById({ taskId: task.taskId, status: "succeeded", endedAt: 20 }),
  ).not.toBeNull();
  // Retain SQL attribution for cached statements, then exclude fixture setup.
  rememberPreparedSql();
  for (const counter of counters) {
    counter.mockClear();
  }
  const hostSql = observeDeviceAuthHostSql(state.statePath("state", "openclaw.sqlite"));
  const startedAt = performance.now();
  await vi.advanceTimersByTimeAsync(1_000);
  await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  expect(readResidentTaskFlow(flow.flowId)).toMatchObject({
    goal: "Live insertion winner",
    revision: 5,
    status: "succeeded",
  });
  const beforeCloseSql = hostSql.counts();
  expect(Object.values(beforeCloseSql).flatMap((counts) => Object.values(counts))).toEqual(
    Array(28).fill(0),
  );
  await closeOpenClawStateDatabaseAsync();
  console.info("Live flow host SQL", { beforeClose: beforeCloseSql, afterClose: hostSql.counts() });
  rememberPreparedSql();
  let unattributedStatements = 0;
  const sql = [
    ...[...prepare.mock.calls, ...exec.mock.calls].map(([statement]) => statement),
    ...statements.flatMap((counter) =>
      counter.mock.contexts.flatMap((receiver) => {
        const text =
          receiver && typeof receiver === "object" ? statementSql.get(receiver) : undefined;
        if (text === undefined) {
          unattributedStatements += 1;
          return [];
        }
        return [text];
      }),
    ),
  ];
  const domainSql = sql.filter((statement) => /\b(?:task_runs|flow_runs)\b/u.test(statement));
  console.info("live task-flow retry and close", {
    elapsedMs: performance.now() - startedAt,
    parentSqlCalls: counters.map((counter) => counter.mock.calls.length),
    parentTaskFlowStatements: domainSql.length,
    unattributedStatements,
  });
  expect(unattributedStatements).toBe(0);
  expect(domainSql).toEqual([]);
  hostSql.restore();
  vi.restoreAllMocks();
  expect(loadTaskFlowRegistryStateFromSqliteReadOnly().flows.get(flow.flowId)).toMatchObject({
    goal: "Live insertion winner",
    revision: 5,
  });
});
