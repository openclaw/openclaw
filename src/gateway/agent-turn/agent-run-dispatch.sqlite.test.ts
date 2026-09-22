import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { observeDeviceAuthHostSql } from "../../infra/device-auth-store.sql.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../../plugins/registry-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureTaskExecutionOwner } from "../../tasks/task-execution-owner.js";
import { loadTaskFlowRegistryStateFromSqlite } from "../../tasks/task-flow-registry.store.sqlite.js";
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
import { dispatchAgentRunFromGateway } from "./agent-run-dispatch.js";
import { createTrackedDispatch } from "./agent-run-dispatch.test-support.js";
import type { AgentTurnIo } from "./types.js";

const provider = vi.hoisted(() => ({
  execute: vi.fn<typeof import("../../commands/agent.js").agentCommandFromGatewayIngress>(),
}));
vi.mock("../../commands/agent.js", () => ({
  agentCommandFromGatewayIngress: provider.execute,
}));

type HostWrites = { task: number; delivery: number; flow: number };

function workerOperation(message: unknown): string[] {
  if (!isRecord(message) || message.type !== "execute" || !Buffer.isBuffer(message.input)) {
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
        const workerMessages = vi.spyOn(Worker.prototype, "postMessage");
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
          // Live run-owner binding is still a separate native writer in this initial-creation slice.
          expect(observed.writes).toEqual(
            expectedExecutionOwner ? { task: 1, delivery: 1, flow: 0 } : noWrites,
          );
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
          const commands = workerMessages.mock.calls.flatMap(([message]) =>
            workerOperation(message),
          );
          expect(
            commands.filter((command) =>
              ["tasks.createRecord", "tasks.settleUnstarted", "tasks.finalizeActive"].includes(
                command,
              ),
            ),
          ).toEqual([
            "tasks.createRecord",
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
