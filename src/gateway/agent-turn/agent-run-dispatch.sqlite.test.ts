import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
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
import { configureTaskRegistryRuntime } from "../../tasks/task-registry.store.js";
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

it.each(["unstarted", "active"] as const)(
  "creates a durable Gateway task before provider entry and settles its %s receipt",
  async (phase) => {
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
        const noWrites: HostWrites = { task: 0, delivery: 0, flow: 0 };
        let creation: { taskId: string; writes: HostWrites } | undefined;
        configureTaskRegistryRuntime({
          observers: {
            onEvent(event) {
              if (!creation && event.kind === "upserted" && event.task.runId === runId) {
                creation = { taskId: event.task.taskId, writes: { ...tracker.counts } };
              }
            },
          },
        });
        const entered = createDeferred<{
          tasks: TaskRecord[];
          flowCount: number;
          writes: HostWrites;
        }>();
        const releaseProvider = createDeferred();
        const failure = new Error("Synthetic provider preparation failure");
        provider.execute.mockImplementation(async (opts) => {
          if (phase === "active") {
            expectDefined(opts.onExecutionStarted, "Gateway execution-start callback")();
          }
          const snapshot = loadTaskRegistryStateFromSqlite();
          entered.resolve({
            tasks: [...snapshot.tasks.values()].filter((record) => record.runId === runId),
            flowCount: loadTaskFlowRegistryStateFromSqlite().flows.size,
            writes: { ...tracker.counts },
          });
          await releaseProvider.promise;
          throw failure;
        });
        const emitFinal = vi.fn<AgentTurnIo["emitFinal"]>();
        const assertSettlementCurrent = () => {
          if (context.chatAbortControllers.get(runId) !== entry) {
            throw new Error("Synthetic Gateway dispatch lost its original registration");
          }
        };
        let execution: ReturnType<typeof dispatchAgentRunFromGateway> | undefined;
        try {
          execution = dispatchAgentRunFromGateway({
            admittedRunEntry: entry,
            assertCurrent() {
              entry.controller.signal.throwIfAborted();
              assertSettlementCurrent();
            },
            assertSettlementCurrent,
            ingressOpts: {
              message: task.task,
              sessionKey,
              allowModelOverride: false,
            },
            runId,
            dedupeKeys: [`agent:${runId}`],
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
          expect(running.parentFlowId).toBeUndefined();
          expect(observed.flowCount).toBe(0);
          // Live run-owner binding is still a separate native writer in this initial-creation slice.
          expect(observed.writes).toEqual(
            expectedExecutionOwner ? { task: 1, delivery: 1, flow: 0 } : noWrites,
          );
          expect(running.executionOwner).toEqual(expectedExecutionOwner);
          expect(getTaskRunOwner(running)).toBeDefined();
          expect(emitFinal).not.toHaveBeenCalled();
          const beforeSettlement = { ...tracker.counts };
          releaseProvider.resolve();
          await execution;

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
            phase === "active" ? "tasks.finalizeActive" : "tasks.settleUnstarted",
          ]);
        } finally {
          releaseProvider.resolve();
          await execution;
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
