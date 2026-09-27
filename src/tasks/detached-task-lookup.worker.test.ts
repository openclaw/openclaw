import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { waitForCompletionRequiredAsyncTasks } from "../agents/embedded-agent-runner/run/attempt-async-tasks.js";
import { reconcileProvisionalSubagentKill } from "../agents/subagents/registry/subagent-registry-sweep-kill.js";
import type {
  SubagentCompletionRequest,
  SubagentRunRecord,
} from "../agents/subagents/registry/subagent-registry.types.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { markPluginRegistryRetired } from "../plugins/registry-lifecycle.js";
import {
  createPluginRegistryOwner,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { holdStateDatabaseWriteTransaction } from "../test-utils/state-database-contention.js";
import { DetachedTaskRuntimeOwnerRetiredError } from "./detached-task-runtime-contract.js";
import { finalizeTaskRunByRunIdAsync } from "./detached-task-runtime.async.js";
import { findDetachedTaskRunAsync } from "./detached-task-runtime.js";
import { createAcpTaskBackingDetail } from "./task-backing-records.js";
import { createFlowRecord } from "./task-flow-registry.test-support.js";
import { findTaskByRunIdAsync } from "./task-registry-query.js";
import { prepareTaskRegistryRead } from "./task-registry-read.js";
import { upsertTaskWithDeliveryStateToSqlite } from "./task-registry.store.sqlite.js";
import { createTaskFixture } from "./task-registry.test-support.js";
import type { TaskRecord } from "./task-registry.types.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";

afterEach(() => {
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetAgentEventsForTest({ preserveListeners: true });
});

it.each([
  { gatewayA: "open", operation: "lookup" },
  { gatewayA: "closing", operation: "lookup" },
  { gatewayA: "open", operation: "settlement" },
  { gatewayA: "closing", operation: "settlement" },
] as const)(
  "reaches a child's stored task from a replaced plugin generation only through its $gatewayA admitting Gateway ($operation)",
  async ({ gatewayA, operation }) => {
    await withOpenClawTestState({ layout: "split" }, async () => {
      const runId = "reload-owner-run";
      const sessionKey = "agent:main:subagent:reload-owner";
      const task = createTaskFixture("subagent", {
        runId,
        childSessionKey: sessionKey,
        task: "Reload owner proof",
        notifyPolicy: "silent",
      });
      const spawning = createEmptyPluginRegistry();
      setActivePluginRegistry(spawning);
      const gateway = createPluginRegistryOwner(spawning);
      const allowed = gatewayA === "open";
      try {
        // Gateway A reloads; Gateway B is live and process-active but never succeeds A.
        const successor = createEmptyPluginRegistry();
        setActivePluginRegistry(successor);
        gateway.publish(successor);
        markPluginRegistryRetired(spawning);
        const other = createEmptyPluginRegistry();
        setActivePluginRegistry(other);
        createPluginRegistryOwner(other);
        if (!allowed) {
          await gateway.close();
        }

        if (operation === "lookup") {
          const result = await withPluginRuntimeRegistryScope(spawning, () =>
            findDetachedTaskRunAsync({
              runId,
              runtime: "subagent",
              sessionKey,
              createdAtOrAfter: task.createdAt,
            }),
          );
          expect(result).toEqual(
            allowed
              ? { lookup: "available", task: expect.objectContaining({ taskId: task.taskId }) }
              : { lookup: "unavailable" },
          );
        } else {
          const settlement = withPluginRuntimeRegistryScope(spawning, () =>
            finalizeTaskRunByRunIdAsync({
              runId,
              runtime: "subagent",
              sessionKey,
              status: "succeeded",
              endedAt: task.createdAt + 1,
            }),
          );
          if (allowed) {
            await expect(settlement).resolves.toEqual([
              expect.objectContaining({ taskId: task.taskId, status: "succeeded" }),
            ]);
          } else {
            await expect(settlement).rejects.toBeInstanceOf(DetachedTaskRuntimeOwnerRetiredError);
          }
        }
        // The stored row is the final effect: written only through the admitting Gateway.
        const stored = await findTaskByRunIdAsync(runId, await prepareTaskRegistryRead());
        expect(stored?.status).toBe(
          operation === "settlement" && allowed ? "succeeded" : "running",
        );
      } finally {
        resetPluginRuntimeStateForTest();
        await closeOpenClawStateDatabaseAsync();
      }
    });
  },
);

it.each([
  "detached lookup",
  "kill reconciliation",
  "completion-required wait",
  "aborted wait",
] as const)(
  "keeps the event loop responsive during %s behind accepted task events",
  async (surface) => {
    await withOpenClawTestState({ layout: "split" }, async (state) => {
      expect(process.env.HOME).toBe(state.home);
      expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
      const runId = "private-contended-detached-lookup";
      const sessionKey = "agent:main:subagent:private-lookup";
      const task = createTaskFixture("subagent", {
        runId,
        childSessionKey: sessionKey,
        task: "Private lookup contention proof",
        notifyPolicy: "silent",
        deliveryStatus: "not_applicable",
      });
      await prepareTaskRegistryRead();
      const context = captureOpenClawStateWorkerContext();
      expect(context.admission.databasePath.startsWith(state.stateDir)).toBe(true);
      const holder = holdStateDatabaseWriteTransaction(context.admission.databasePath, 300);
      let pending: Promise<unknown> | undefined;
      let settled: Promise<PromiseSettledResult<unknown>[]> | undefined;
      const abort = new AbortController();
      const complete = vi.fn(async (_completion: SubagentCompletionRequest) => {});
      try {
        await holder.ready;
        const heartbeat = nextTurn().then(() => Atomics.load(holder.released, 0));
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: { phase: "end", endedAt: task.createdAt + 1 },
        });
        if (surface === "detached lookup") {
          pending = findDetachedTaskRunAsync({
            runId,
            runtime: "subagent",
            sessionKey,
            createdAtOrAfter: task.createdAt,
          });
        } else if (surface === "completion-required wait" || surface === "aborted wait") {
          pending = waitForCompletionRequiredAsyncTasks({
            getToolMetas: () => [{ asyncStarted: true, asyncTaskRunId: runId }],
            getDeadlineAtMs: () => undefined,
            abortSignal: abort.signal,
            sleep: async () => {
              throw new Error("The accepted completion should settle before a poll sleep");
            },
          }).then((result) => ({ lookup: "available", task: result.terminalTasks[0] }));
        } else {
          const entry: SubagentRunRecord = {
            runId,
            childSessionKey: sessionKey,
            requesterSessionKey: task.ownerKey,
            requesterDisplayKey: "private requester",
            task: task.task,
            cleanup: "keep",
            createdAt: task.createdAt,
            execution: { status: "terminal" },
            endedReason: "subagent-killed",
            killReconciliation: { killedAt: task.createdAt + 2 },
          };
          pending = reconcileProvisionalSubagentKill({
            runId,
            entry,
            now: task.createdAt + 3,
            runs: new Map([[runId, entry]]),
            getRunsForChildSession: () => [entry],
            completeSubagentRunWithRecovery: complete,
            retireSupersededRun: async () => {
              throw new Error("No successor exists");
            },
            startSubagentAnnounceCleanupFlow: () => {
              throw new Error("Terminal replay owns completion");
            },
            warn: () => {
              throw new Error("Unexpected reconciliation failure");
            },
          });
        }
        settled = Promise.allSettled([pending]);
        const releasedAtHeartbeat = await heartbeat;
        if (surface === "aborted wait") {
          abort.abort();
          await expect(pending).rejects.toMatchObject({ name: "AbortError" });
          expect(
            Atomics.load(holder.released, 0),
            "cancellation must settle before the write transaction holder releases",
          ).toBe(0);
        }
        holder.release();
        if (surface === "aborted wait") {
          const read = await prepareTaskRegistryRead();
          expect(read?.getTaskById(task.taskId)).toMatchObject({ status: "succeeded" });
        } else if (surface === "kill reconciliation") {
          expect(await pending).toBe(false);
          expect(complete).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              runId,
              endedAt: task.createdAt + 1,
              outcome: { status: "ok" },
            }),
            "sweeper-provisional-kill-task-completion",
          );
        } else {
          expect(await pending).toMatchObject({
            lookup: "available",
            task: { taskId: task.taskId, status: "succeeded" },
          });
        }
        expect(releasedAtHeartbeat, "heartbeat must run while contention is still held").toBe(0);
      } finally {
        holder.release();
        await holder.joined;
        await settled;
        await closeOpenClawStateDatabaseAsync();
      }
    });
  },
);

it("keeps async lookup scoped to current ACP backing and the requested subagent generation", async () => {
  await withOpenClawTestState({ layout: "split" }, async () => {
    try {
      const flow = createFlowRecord({
        ownerKey: "agent:main:main",
        goal: "Lookup fixture",
        syncMode: "task_mirrored",
      });
      expect(flow).not.toBeNull();
      const task = (
        taskId: string,
        createdAt: number,
        overrides: Partial<TaskRecord>,
      ): TaskRecord => ({
        taskId,
        createdAt,
        runtime: "subagent",
        ownerKey: "agent:main:main",
        requesterSessionKey: "agent:main:main",
        scopeKind: "session",
        task: "Synthetic lookup selection",
        status: "succeeded",
        endedAt: createdAt + 1,
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        childSessionKey: "agent:main:subagent:selection",
        ...overrides,
      });
      const acp = {
        runtime: "acp" as const,
        childSessionKey: "agent:main:acp:selection",
        runId: "shared-acp",
      };
      for (const row of [
        task("replaced-acp", 30, {
          ...acp,
          parentFlowId: flow!.flowId,
          detail: createAcpTaskBackingDetail("old", 1),
        }),
        task("current-acp", 20, {
          ...acp,
          parentFlowId: flow!.flowId,
          detail: createAcpTaskBackingDetail("current", 2),
        }),
        task("earlier-child", 100, { runId: "earlier-run" }),
        task("later-child", 300, { runId: "later-run" }),
      ]) {
        upsertTaskWithDeliveryStateToSqlite({ task: row });
      }
      expect(await findTaskByRunIdAsync("shared-acp")).toMatchObject({ taskId: "current-acp" });
      const lookup = {
        runId: "continuation-run",
        runtime: "subagent" as const,
        sessionKey: "agent:main:subagent:selection",
        createdAtOrAfter: 100,
        createdBefore: 200,
      };
      expect(await findDetachedTaskRunAsync(lookup)).toEqual({
        lookup: "available",
        task: undefined,
      });
      expect(
        await findDetachedTaskRunAsync({ ...lookup, allowSessionFallback: true }),
      ).toMatchObject({
        lookup: "available",
        task: { taskId: "earlier-child", runId: "earlier-run" },
      });
      expect(
        await findDetachedTaskRunAsync({
          ...lookup,
          runId: "earlier-run",
          sessionKey: "agent:main:subagent:other",
        }),
      ).toEqual({ lookup: "available", task: undefined });
    } finally {
      await closeOpenClawStateDatabaseAsync();
    }
  });
});
