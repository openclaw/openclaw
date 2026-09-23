import { deserialize, serialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { observeDeviceAuthHostSql } from "../../infra/device-auth-store.sql.test-support.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../../plugins/registry-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { captureTaskExecutionOwner } from "../../tasks/task-execution-owner.js";
import { createRunningTaskRunCoreWithReceiptAsync } from "../../tasks/task-executor-create.async.js";
import { loadTaskFlowRegistryStateFromSqlite } from "../../tasks/task-flow-registry.store.sqlite.js";
import * as taskLineage from "../../tasks/task-registry-agent-event-lineage.js";
import { requestTasks } from "../../tasks/task-registry-read.test-support.js";
import { taskDeliveryStates, tasks } from "../../tasks/task-registry-state.js";
import {
  configureTaskRegistryRuntime,
  getTaskRegistryStore,
} from "../../tasks/task-registry.store.js";
import { loadTaskRegistryStateFromSqlite } from "../../tasks/task-registry.store.sqlite.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import { getTaskRunOwner } from "../../tasks/task-run-owner.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "../../tasks/task-runtime.test-helpers.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { holdStateDatabaseCoordinator } from "../../test-utils/state-database-contention.js";
import { dispatchAgentRunFromGateway } from "./agent-run-dispatch.js";
import { createTrackedDispatch } from "./agent-run-dispatch.test-support.js";
import { registerSessionFollowupTask } from "./agent-run-task-tracking.js";
import type { AgentTurnIo } from "./types.js";

const provider = vi.hoisted(() => ({
  execute: vi.fn<typeof import("../../commands/agent.js").agentCommandFromGatewayIngress>(),
}));

it.each(["succeeded", "failed", "cancelled", "timed_out"] as const)(
  "releases rejected follow-up lineage without rewriting a %s task",
  async (status) => {
    const state = await createOpenClawTestState({ layout: "state-only" });
    const registry = createEmptyPluginRegistry();
    const retained = new Set<() => void>();
    const retain = taskLineage.retainTaskAgentEventLineage;
    const subscriptions = vi
      .spyOn(taskLineage, "retainTaskAgentEventLineage")
      .mockImplementation((...args) => {
        const close = retain(...args);
        retained.add(close);
        return () => {
          close();
          retained.delete(close);
        };
      });
    markPluginRegistryActive(registry);
    try {
      await withPluginRuntimeRegistryScope(registry, async () => {
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
        const params = {
          followup: {
            kind: "session_followup" as const,
            requesterSessionKey: "agent:main:parent",
          },
          runId: "terminal-followup",
          sessionKey: "agent:main:child",
          task: "Preserve the completed follow-up",
          requesterOrigin: undefined,
          assertCurrent: () => {},
        };
        const created = await registerSessionFollowupTask(params);
        if (created.kind !== "receipt") {
          throw new Error("Expected the core task creation receipt");
        }
        expect(retained.size).toBe(1);
        await created.finalizeActive(
          { status, endedAt: Date.now(), terminalSummary: "Original terminal outcome" },
          () => true,
        );
        expect(retained.size).toBe(0);
        const before = loadTaskRegistryStateFromSqlite();
        expect(before.tasks.get(created.task.taskId)?.status).toBe(status);

        // The earlier tracking lookup had no task; creation now finds a terminal row.
        await expect(registerSessionFollowupTask(params)).rejects.toThrow(
          "Follow-up task registration failed; run was not started.",
        );
        expect(retained.size).toBe(0);
        expect(loadTaskRegistryStateFromSqlite()).toEqual(before);
        expect(getTaskRunOwner(created.task)).toBeUndefined();
      });
    } finally {
      for (const close of retained) {
        close();
      }
      subscriptions.mockRestore();
      await closeOpenClawStateDatabaseAsync();
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      markPluginRegistryRetired(registry);
      await state.cleanup();
    }
  },
);

it.each([
  "activate",
  "reuse",
  "large record",
  "cancel",
  "replace",
  "pending terminal",
  "pending start",
  "active pending start",
  "cancel pending start",
  "replace pending start",
  "commit error pending start",
  "precommit error pending start",
  "cancel pending event",
] as const)(
  "keeps Gateway activation responsive while the run-owner coordinator is held (%s)",
  async (outcome) => {
    const state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "gateway-run-owner-contention-",
    });
    const registry = createEmptyPluginRegistry();
    markPluginRegistryActive(registry);
    try {
      await withPluginRuntimeRegistryScope(registry, async () => {
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
        const { runId, sessionKey, context, entry, task } = createTrackedDispatch();
        const cancelBeforeBinding =
          outcome === "cancel" ||
          outcome === "cancel pending event" ||
          outcome === "cancel pending start";
        const replaceBeforeBinding = outcome === "replace" || outcome === "replace pending start";
        const startBeforeBinding = outcome.endsWith("pending start");
        const eventCommitted = outcome === "commit error pending start";
        const eventFailure =
          eventCommitted || outcome === "precommit error pending start"
            ? new SqliteWorkerError(
                `Synthetic event failed ${eventCommitted ? "after commit" : "before mutation"}`,
                "outcome-unknown",
              )
            : undefined;
        const terminalBeforeBinding =
          outcome === "pending terminal" || outcome === "cancel pending event";
        const assertCurrent = () => {
          entry.controller.signal.throwIfAborted();
          if (context.chatAbortControllers.get(runId) !== entry) {
            throw new Error("Gateway dispatch lost its original registration");
          }
        };
        const create = () =>
          createRunningTaskRunCoreWithReceiptAsync(
            {
              runtime: "cli",
              sourceId: runId,
              runId,
              ownerKey: sessionKey,
              childSessionKey: sessionKey,
              scopeKind: "session",
              task: task.task,
              ...(outcome === "large record"
                ? { detail: { payload: "x".repeat(1024 * 1024) } }
                : {}),
              deliveryStatus: "not_applicable",
              startedAt: Date.now(),
            },
            assertCurrent,
          );
        const originalReceipt = await create();
        const receipt = outcome === "reuse" ? await create() : originalReceipt;
        if (!receipt) {
          throw new Error("Expected the original durable Gateway task receipt");
        }
        expect(receipt.task.taskId).toBe(originalReceipt?.task.taskId);
        const initialCreatedAt = receipt.task.createdAt;
        const workerContext = captureOpenClawStateWorkerContext();
        const held = holdStateDatabaseCoordinator(
          workerContext.admission.databasePath,
          workerContext.coordinatorRuntime,
          5_000,
        );
        const entered = createDeferred();
        const releaseProvider = createDeferred();
        const timerObserved = createDeferred<number>();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let sampleTimer: ReturnType<typeof setInterval> | undefined;
        const mutations = vi.spyOn(getTaskRegistryStore(), "runInitialMutationAsync");
        const store = getTaskRegistryStore();
        const mutateEvent = store.runAgentEventMutationAsync.bind(store);
        const eventMutation = eventFailure
          ? vi
              .spyOn(store, "runAgentEventMutationAsync")
              .mockImplementationOnce(async (...args) => {
                if (eventCommitted) {
                  const committed = await mutateEvent(...args);
                  expect(committed?.task.createdAt).toBe(initialCreatedAt - 1_000);
                }
                throw eventFailure;
              })
          : undefined;
        let execution: ReturnType<typeof dispatchAgentRunFromGateway> | undefined;
        provider.execute.mockImplementation(async (options) => {
          entered.resolve();
          if (outcome === "active pending start") {
            await options.onExecutionStarted?.();
          }
          await releaseProvider.promise;
          return { payloads: [], meta: { durationMs: 0 } };
        });
        try {
          await held.ready;
          if (terminalBeforeBinding) {
            emitAgentEvent({
              runId,
              stream: "lifecycle",
              data: { phase: "end", endedAt: Date.now() },
            });
          }
          if (startBeforeBinding) {
            emitAgentEvent({
              runId,
              stream: "lifecycle",
              data: { phase: "start", startedAt: initialCreatedAt - 1_000 },
            });
          }
          // The holder's independent watchdog releases a synchronously blocked host.
          // An ordinary main-loop turn must instead run while that lease is held.
          timer = setTimeout(() => {
            timer = undefined;
            timerObserved.resolve(Atomics.load(held.released, 0));
          }, 0);
          const started = performance.now();
          const beforeMemory = process.memoryUsage();
          let lastTimer = started;
          let maxTimerGapMs = 0;
          sampleTimer = setInterval(() => {
            const now = performance.now();
            maxTimerGapMs = Math.max(maxTimerGapMs, now - lastTimer);
            lastTimer = now;
          }, 1);
          execution = dispatchAgentRunFromGateway({
            assertCurrent,
            assertSettlementCurrent: assertCurrent,
            ingressOpts: { message: task.task, sessionKey, allowModelOverride: false },
            runId,
            dedupeKeys: [`agent:${runId}`],
            admittedRunEntry: entry,
            abortController: entry.controller,
            cleanupAbortController() {
              if (context.chatAbortControllers.get(runId) === entry) {
                context.chatAbortControllers.delete(runId);
              }
            },
            io: { emitAcceptance: vi.fn(), emitFinal: vi.fn() },
            context,
            taskTrackingMode: { kind: "receipt", ...receipt },
          });
          const releasedAtTimer = await withTestTimeout(
            timerObserved.promise,
            10_000,
            "Gateway activation did not yield to its main timer",
          );
          console.info("Gateway run-owner coordinator wait", {
            mainTimerMs: performance.now() - started,
            releasedAtTimer,
          });
          expect(releasedAtTimer).toBe(0);
          expect(provider.execute).not.toHaveBeenCalled();
          if (cancelBeforeBinding) {
            entry.controller.abort();
          } else if (replaceBeforeBinding) {
            context.chatAbortControllers.set(runId, {
              ...entry,
              controller: new AbortController(),
            });
          }
          held.release();
          await expect(held.joined).resolves.toBe(0);
          if (eventFailure) {
            await execution;
            const renderedError = `${eventFailure.message} | outcome-unknown`;
            expect(provider.execute).not.toHaveBeenCalled();
            expect(getTaskRunOwner(receipt.task)).toBeUndefined();
            expect(context.chatAbortControllers.has(runId)).toBe(false);
            expect(context.dedupe.get(`agent:${runId}`)?.payload).toMatchObject({
              status: "error",
              summary: renderedError,
            });
            const persisted = loadTaskRegistryStateFromSqlite().tasks.get(receipt.task.taskId);
            expect(persisted).toMatchObject({
              status: "failed",
              error: renderedError,
              createdAt: eventCommitted ? initialCreatedAt - 1_000 : initialCreatedAt,
            });
            expect(receipt.task.createdAt).toBe(initialCreatedAt);
            return;
          }
          if (cancelBeforeBinding || replaceBeforeBinding) {
            await execution;
            expect(provider.execute).not.toHaveBeenCalled();
            expect(getTaskRunOwner(receipt.task)).toBeUndefined();
            const persisted = loadTaskRegistryStateFromSqlite().tasks.get(receipt.task.taskId);
            expect(persisted?.executionOwner).toEqual(receipt.task.executionOwner);
            expect(persisted?.status).toBe(
              terminalBeforeBinding ? "succeeded" : cancelBeforeBinding ? "cancelled" : "running",
            );
            expect(context.chatAbortControllers.has(runId)).toBe(replaceBeforeBinding);
            if (startBeforeBinding) {
              expect(persisted?.createdAt).toBe(initialCreatedAt - 1_000);
              expect(receipt.task.createdAt).toBe(initialCreatedAt);
            }
            return;
          }
          await withTestTimeout(
            Promise.race([
              entered.promise,
              execution.then(({ terminalOutcome }) => {
                throw new Error(
                  `Gateway settled before activation: ${terminalOutcome.error ?? terminalOutcome.status}`,
                );
              }),
            ]),
            5_000,
            "Gateway did not activate after admission",
          );
          clearInterval(sampleTimer);
          sampleTimer = undefined;
          maxTimerGapMs = Math.max(maxTimerGapMs, performance.now() - lastTimer);
          const afterMemory = process.memoryUsage();
          const bindingIndex = mutations.mock.calls.findIndex(
            ([, command]) => command.type === "tasks.bindRunOwner",
          );
          if (bindingIndex < 0) {
            throw new Error("Expected the real run-owner worker mutation");
          }
          const requestBytes = serialize(mutations.mock.calls[bindingIndex]?.[1]).byteLength;
          const receiptBytes = serialize(
            await mutations.mock.results[bindingIndex]?.value,
          ).byteLength;
          expect(requestBytes).toBeLessThan(4096);
          console.info("Gateway run-owner transfer", {
            outcome,
            requestBytes,
            receiptBytes,
            maxTimerGapMs,
            rssDelta: afterMemory.rss - beforeMemory.rss,
            heapUsedDelta: afterMemory.heapUsed - beforeMemory.heapUsed,
          });
          const persisted = loadTaskRegistryStateFromSqlite().tasks.get(receipt.task.taskId);
          expect(persisted?.executionOwner).toEqual(
            outcome === "pending terminal"
              ? receipt.task.executionOwner
              : captureTaskExecutionOwner(),
          );
          expect(persisted?.status).toBe(outcome === "pending terminal" ? "succeeded" : "running");
          expect(persisted?.detail).toEqual(receipt.task.detail);
          if (startBeforeBinding) {
            expect(persisted).toMatchObject({
              createdAt: initialCreatedAt - 1_000,
              startedAt: initialCreatedAt - 1_000,
            });
            expect(receipt.task.createdAt).toBe(initialCreatedAt);
          }
          if (outcome === "large record") {
            expect(receiptBytes).toBeGreaterThan(1024 * 1024);
          }
          expect(getTaskRunOwner(receipt.task)).toBeDefined();
          releaseProvider.resolve();
          await execution;
          expect(getTaskRunOwner(receipt.task)).toBeUndefined();
          expect(loadTaskRegistryStateFromSqlite().tasks.get(receipt.task.taskId)?.status).toBe(
            "succeeded",
          );
        } finally {
          held.release();
          releaseProvider.resolve();
          if (timer !== undefined) {
            clearTimeout(timer);
          }
          clearInterval(sampleTimer);
          await Promise.allSettled([execution, held.joined]);
          mutations.mockRestore();
          eventMutation?.mockRestore();
          provider.execute.mockReset();
          await closeOpenClawStateDatabaseAsync();
          resetTaskRegistryForTests({ persist: false });
          resetTaskFlowRegistryForTests({ persist: false });
        }
      });
    } finally {
      markPluginRegistryRetired(registry);
      await state.cleanup();
    }
  },
);
vi.mock("../../commands/agent.js", () => ({
  agentCommandFromGatewayIngress: provider.execute,
}));

type HostWrites = { task: number; delivery: number; flow: number };

function workerOperation(message: unknown): string[] {
  if (!isRecord(message) || message.type !== "execute" || !(message.input instanceof Uint8Array)) {
    return [];
  }
  const command: unknown = deserialize(message.input);
  return isRecord(command) && typeof command.type === "string" ? [command.type] : [];
}

it.each([
  { activation: "unstarted", active: false },
  { activation: "active", active: true },
])(
  "creates a durable Gateway task before provider entry and settles its $activation receipt",
  async ({ active }) => {
    const state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "gateway-dispatch-sqlite-",
    });
    const registry = createEmptyPluginRegistry();
    markPluginRegistryActive(registry);
    try {
      await withPluginRuntimeRegistryScope(registry, async () => {
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
        const { runId, sessionKey, context, entry, task } = createTrackedDispatch();
        const expectedExecutionOwner = captureTaskExecutionOwner();
        const { db } = openOpenClawStateDatabase();
        const tracker = trackSqliteStatementExecutions<keyof HostWrites>(
          db,
          ["task", "delivery", "flow"],
          (sql) => {
            if (!/^\s*(?:insert|update|delete)\b/i.test(sql)) {
              return null;
            }
            if (/\btask_delivery_state\b/i.test(sql)) {
              return "delivery";
            }
            if (/\btask_runs\b/i.test(sql)) {
              return "task";
            }
            return /\bflow_runs\b/i.test(sql) ? "flow" : null;
          },
        );
        const commands: string[] = [];
        // oxlint-disable-next-line typescript/unbound-method -- call restores the sending worker below.
        const originalPost = Worker.prototype.postMessage;
        const workerMessages = vi
          .spyOn(Worker.prototype, "postMessage")
          .mockImplementation(function (this: Worker, message, transferList) {
            commands.push(...workerOperation(message));
            return originalPost.call(this, message, transferList);
          });
        const hostSql = observeDeviceAuthHostSql(state.statePath("state", "openclaw.sqlite"));
        let creationSql: ReturnType<typeof hostSql.counts> | undefined;
        const noWrites: HostWrites = { task: 0, delivery: 0, flow: 0 };
        let creation: { taskId: string; writes: HostWrites } | undefined;
        configureTaskRegistryRuntime({
          observers: {
            onEvent(event) {
              if (!creation && event.kind === "upserted" && event.task.runId === runId) {
                creation = { taskId: event.task.taskId, writes: { ...tracker.counts } };
                creationSql = hostSql.counts();
              }
            },
          },
        });
        const entered = createDeferred<{
          tasks: TaskRecord[];
          flowCount: number;
          writes: HostWrites;
        }>();
        const allowActivation = createDeferred();
        const providerStarted = createDeferred();
        const releaseProvider = createDeferred();
        const terminalCommitted = createDeferred();
        const releaseSettlement = createDeferred();
        const store = getTaskRegistryStore();
        const mutate = store.runInitialMutationAsync.bind(store);
        const settlement = vi
          .spyOn(store, "runInitialMutationAsync")
          .mockImplementation(async (...args) => {
            const result = await mutate(...args);
            if (
              args[1].type === "tasks.finalizeActive" ||
              args[1].type === "tasks.settleUnstarted"
            ) {
              terminalCommitted.resolve();
              await releaseSettlement.promise;
            }
            return result;
          });
        const failure = new Error("Synthetic provider preparation failure");
        provider.execute.mockImplementation(async (options) => {
          const snapshot = loadTaskRegistryStateFromSqlite();
          entered.resolve({
            tasks: [...snapshot.tasks.values()].filter((record) => record.runId === runId),
            flowCount: loadTaskFlowRegistryStateFromSqlite().flows.size,
            writes: { ...tracker.counts },
          });
          await allowActivation.promise;
          if (active) {
            await options.onExecutionStarted?.();
          }
          providerStarted.resolve();
          await releaseProvider.promise;
          throw failure;
        });
        const emitFinal = vi.fn<AgentTurnIo["emitFinal"]>();
        let execution: ReturnType<typeof dispatchAgentRunFromGateway> | undefined;
        try {
          execution = dispatchAgentRunFromGateway({
            assertCurrent() {
              entry.controller.signal.throwIfAborted();
              if (context.chatAbortControllers.get(runId) !== entry) {
                throw new Error("Synthetic Gateway dispatch lost its original registration");
              }
            },
            assertSettlementCurrent() {
              if (context.chatAbortControllers.get(runId) !== entry) {
                throw new Error("Synthetic Gateway settlement lost its original registration");
              }
            },
            ingressOpts: {
              message: task.task,
              sessionKey,
              channel: "webchat",
              to: sessionKey,
              allowModelOverride: false,
            },
            runId,
            dedupeKeys: [`agent:${runId}`],
            admittedRunEntry: entry,
            abortController: entry.controller,
            cleanupAbortController() {
              if (context.chatAbortControllers.get(runId) === entry) {
                context.chatAbortControllers.delete(runId);
              }
            },
            io: { emitAcceptance: vi.fn(), emitFinal },
            context,
            taskTrackingMode: "cli",
          });
          const observed = await Promise.race([
            entered.promise,
            execution.then(() => {
              throw new Error("Gateway dispatch settled before reaching the provider boundary");
            }),
          ]);
          expect(observed.tasks).toHaveLength(1);
          const running = observed.tasks[0];
          if (!running) {
            throw new Error("Expected the task committed before provider entry");
          }
          expect(running).toMatchObject({
            runtime: "cli",
            runId,
            ownerKey: sessionKey,
            childSessionKey: sessionKey,
            status: "running",
            deliveryStatus: "not_applicable",
            notifyPolicy: "silent",
          });
          expect(creation).toEqual({ taskId: running.taskId, writes: noWrites });
          expect(
            Object.values(creationSql ?? {}).flatMap((counts) => Object.values(counts)),
          ).toEqual(Array(28).fill(0));
          expect(running.parentFlowId).toBeUndefined();
          expect(observed.flowCount).toBe(0);
          expect(observed.writes).toEqual(noWrites);
          expect(running.executionOwner).toEqual(expectedExecutionOwner);
          expect(getTaskRunOwner(running)).toBeDefined();
          expect(emitFinal).not.toHaveBeenCalled();
          allowActivation.resolve();
          await Promise.race([
            providerStarted.promise,
            execution.then(() => {
              throw new Error("Gateway dispatch settled before the provider could activate");
            }),
          ]);
          const beforeTerminal = loadTaskRegistryStateFromSqlite();
          expect(beforeTerminal.deliveryStates.get(running.taskId)?.requesterOrigin).toMatchObject({
            channel: "webchat",
            to: sessionKey,
          });
          const beforeSettlement = { ...tracker.counts };
          const beforeSettlementSql = hostSql.counts();
          releaseProvider.resolve();
          await withTestTimeout(
            Promise.race([
              terminalCommitted.promise,
              execution.then(() => {
                throw new Error("Gateway dispatch settled before the terminal publication hold");
              }),
            ]),
            5_000,
            "Terminal worker committed before publication",
          );
          expect(hostSql.counts()).toEqual(beforeSettlementSql);
          expect(emitFinal).not.toHaveBeenCalled();
          const durable = loadTaskRegistryStateFromSqlite();
          expect(durable.tasks.get(running.taskId)).toEqual({
            ...beforeTerminal.tasks.get(running.taskId),
            status: "failed",
            error: failure.message,
            terminalSummary: failure.message,
            endedAt: expect.any(Number),
            lastEventAt: expect.any(Number),
            cleanupAfter: expect.any(Number),
          });
          expect(durable.deliveryStates).toEqual(beforeTerminal.deliveryStates);
          const respond = vi.fn();
          await withTestTimeout(
            requestTasks(sessionKey, respond),
            5_000,
            "Registered task list reads committed terminal state before publication",
          );
          expect(respond).toHaveBeenCalledOnce();
          expect(respond.mock.calls[0]).toMatchObject([
            true,
            {
              tasks: [
                {
                  id: running.taskId,
                  runId,
                  ownerKey: sessionKey,
                  childSessionKey: sessionKey,
                  status: "failed",
                  error: failure.message,
                  terminalSummary: failure.message,
                  deliveryStatus: "not_applicable",
                },
              ],
            },
          ]);
          expect(tasks.get(running.taskId)).toEqual(durable.tasks.get(running.taskId));
          expect(taskDeliveryStates).toEqual(durable.deliveryStates);
          expect(emitFinal).not.toHaveBeenCalled();
          const afterReadSql = hostSql.counts();
          releaseSettlement.resolve();
          await execution;
          expect(hostSql.counts()).toEqual(afterReadSql);
          console.info("Gateway task host SQL", {
            creation: creationSql,
            beforeSettlement: beforeSettlementSql,
            afterSettlement: hostSql.counts(),
          });

          const completed = loadTaskRegistryStateFromSqlite();
          expect([...completed.tasks.keys()]).toEqual([running.taskId]);
          expect(completed.tasks.get(running.taskId)).toMatchObject({
            runId,
            status: "failed",
            error: failure.message,
            terminalSummary: failure.message,
            deliveryStatus: "not_applicable",
            endedAt: expect.any(Number),
          });
          expect(loadTaskFlowRegistryStateFromSqlite().flows.size).toBe(0);
          expect(tracker.counts).toEqual(beforeSettlement);
          expect(getTaskRunOwner(running)).toBeUndefined();
          expect(context.chatAbortControllers.has(runId)).toBe(false);
          expect(provider.execute).toHaveBeenCalledOnce();
          expect(emitFinal).toHaveBeenCalledExactlyOnceWith(
            [
              false,
              { runId, status: "error", summary: failure.message },
              expect.objectContaining({ code: ErrorCodes.UNAVAILABLE, message: failure.message }),
            ],
            { runId, error: failure.message },
          );
          expect(
            commands.filter((command) =>
              [
                "tasks.createRecord",
                "tasks.bindRunOwner",
                "tasks.settleUnstarted",
                "tasks.finalizeActive",
              ].includes(command),
            ),
          ).toEqual([
            "tasks.createRecord",
            "tasks.bindRunOwner",
            active ? "tasks.finalizeActive" : "tasks.settleUnstarted",
          ]);
        } finally {
          allowActivation.resolve();
          releaseProvider.resolve();
          releaseSettlement.resolve();
          await execution;
          settlement.mockRestore();
          hostSql.restore();
          tracker.restore();
          workerMessages.mockRestore();
          provider.execute.mockReset();
          configureTaskRegistryRuntime({ observers: null });
          await closeOpenClawStateDatabaseAsync();
          resetTaskRegistryForTests({ persist: false });
          resetTaskFlowRegistryForTests({ persist: false });
        }
      });
    } finally {
      markPluginRegistryRetired(registry);
      await state.cleanup();
    }
  },
);
