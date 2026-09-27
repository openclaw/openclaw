import { afterAll, describe, expect, test, vi } from "vitest";
import {
  TASKS_LIST_CURSOR_MAX_LENGTH,
  type TasksListResult,
} from "../../packages/gateway-protocol/src/index.js";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import * as inboundDispatch from "../auto-reply/dispatch.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { applyTaskRegistryMaintenanceRetention } from "../tasks/task-registry-maintenance-retention.js";
import * as taskRegistryRead from "../tasks/task-registry-read.js";
import {
  createTaskRecord,
  listTaskRecords,
  markTaskTerminalById,
  publishTaskRecordAfterAtomicStore,
} from "../tasks/task-registry.js";
import {
  configureTaskRegistryRuntime,
  getTaskRegistryStore,
} from "../tasks/task-registry.store.js";
import { reloadTaskRegistryFromStoreAsync } from "../tasks/task-registry.test-support.js";
import { resetTaskRegistryForTests } from "../tasks/task-runtime.test-helpers.js";
import { createInMemoryTaskRegistryStore } from "../test-utils/task-registry-store.js";
import { installGatewayTestHooks, onceMessage } from "./server.auth.test-helpers.js";
import {
  createTaskSnapshot,
  expectedTaskIds,
  expectCursorRejected,
  FOREIGN_SESSION_KEY,
  OWNED_SESSION_KEY,
  type RpcResponse,
  sendRpc,
  TASK_COUNT,
  withAuthenticatedTaskGateway,
} from "./server.tasks-list.test-helpers.js";
import * as taskSessionAccess from "./task-session-access.js";

installGatewayTestHooks({ scope: "suite" });

afterAll(() => {
  resetTaskRegistryForTests({ persist: false });
});

describe("tasks.list Gateway performance", () => {
  test("preserves task cursors across chat liveness while rejecting changed sharing", async () => {
    const tasks = new Map([...createTaskSnapshot()].slice(0, 3));
    await withAuthenticatedTaskGateway(
      () => {
        resetTaskRegistryForTests({ persist: false });
        configureTaskRegistryRuntime({
          store: createInMemoryTaskRegistryStore({ tasks, deliveryStates: new Map() }),
        });
      },
      async ({ admin, viewer }) => {
        const sessionKey = "agent:main:task-cursor-liveness";
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: "task-cursor-liveness",
            lifecycleRevision: "task-cursor-liveness-generation",
            updatedAt: 1,
            displayName: "Synthetic task cursor conversation",
            visibility: "shared",
          },
        );
        const start = createDeferred<() => void>();
        const release = createDeferred();
        const dispatch = vi
          .spyOn(inboundDispatch, "dispatchInboundMessageWithProjectedDispatcher")
          .mockImplementationOnce(async ({ replyOptions }) => {
            const runId = replyOptions?.runId;
            const onAgentRunStart = replyOptions?.onAgentRunStart;
            if (!runId || !onAgentRunStart) {
              throw new Error("Expected the admitted chat run's startup callback");
            }
            start.resolve(() => {
              onAgentRunStart(runId);
            });
            await release.promise;
            return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
          });
        const pending: Promise<unknown>[] = [];
        try {
          const subscribed = await sendRpc(
            admin,
            "task-liveness-subscribe",
            "sessions.subscribe",
            {},
          );
          expect(subscribed.ok, JSON.stringify(subscribed.error)).toBe(true);
          const settled = onceMessage<{
            event?: string;
            payload?: { sessionKey?: string; reason?: string };
          }>(
            admin,
            (frame) =>
              frame.event === "sessions.changed" &&
              frame.payload?.sessionKey === sessionKey &&
              frame.payload.reason === "agent.input.settled",
          );
          pending.push(Promise.allSettled([settled]));
          const sent = await sendRpc(admin, "task-liveness-send", "chat.send", {
            sessionKey,
            message: "Exercise task cursor liveness",
            idempotencyKey: "task-cursor-liveness-run",
          });
          expect(sent.ok, JSON.stringify(sent.error)).toBe(true);
          const startRun = await withTestTimeout(
            start.promise,
            5_000,
            "Chat dispatch did not start",
          );
          const first = await sendRpc<TasksListResult>(viewer, "tasks-before-run", "tasks.list", {
            limit: 1,
          });
          expect(first.ok, JSON.stringify(first.error)).toBe(true);
          const firstCursor = first.payload?.nextCursor;
          if (!firstCursor) {
            throw new Error("Expected a task cursor before the run starts");
          }

          startRun();
          const second = await sendRpc<TasksListResult>(viewer, "tasks-running", "tasks.list", {
            limit: 1,
            cursor: firstCursor,
          });
          expect(second.ok, JSON.stringify(second.error)).toBe(true);
          const secondCursor = second.payload?.nextCursor;
          if (!secondCursor) {
            throw new Error("Expected a task cursor while the run is active");
          }

          release.resolve();
          await settled;
          const third = await sendRpc<TasksListResult>(viewer, "tasks-settled", "tasks.list", {
            limit: 1,
            cursor: secondCursor,
          });
          expect(third.ok, JSON.stringify(third.error)).toBe(true);
          expect(
            [first, second, third].flatMap(
              (page) => page.payload?.tasks.map((task) => task.id) ?? [],
            ),
          ).toEqual(expectedTaskIds(tasks.values(), 0, 3));
          expect(third.payload?.nextCursor).toBeUndefined();

          const sharing = await sendRpc(admin, "task-liveness-sharing", "session.visibility.set", {
            sessionKey: FOREIGN_SESSION_KEY,
            agentId: "main",
            visibility: "draft",
          });
          expect(sharing.ok, JSON.stringify(sharing.error)).toBe(true);
          await expectCursorRejected(viewer, "tasks-after-sharing", {
            cursor: firstCursor,
            limit: 1,
          });
          const current = await sendRpc<TasksListResult>(
            viewer,
            "tasks-current-sharing",
            "tasks.list",
            {},
          );
          expect(current.ok, JSON.stringify(current.error)).toBe(true);
          expect(current.payload?.tasks.map((task) => task.id)).toEqual(
            expectedTaskIds(
              [...tasks.values()].filter((task) => task.requesterSessionKey === OWNED_SESSION_KEY),
              0,
              3,
            ),
          );
        } finally {
          release.resolve();
          await Promise.all(pending);
          dispatch.mockRestore();
        }
      },
    );
  });

  test("keeps authenticated task pages bounded without blocking other RPCs", async () => {
    const tasks = createTaskSnapshot();
    const ownedTasks = [...tasks.values()].filter(
      (task) => task.requesterSessionKey === OWNED_SESSION_KEY,
    );
    const initialOwnedPage = expectedTaskIds(ownedTasks, 10, 25);
    const changedTaskId = initialOwnedPage[0];
    const updatedTask = ownedTasks.find((task) => !initialOwnedPage.includes(task.taskId));
    if (!changedTaskId || !updatedTask) {
      throw new Error("expected selected and unselected owned task fixtures");
    }

    const initializeTasks = () => {
      resetTaskRegistryForTests({ persist: false });
      configureTaskRegistryRuntime({
        store: createInMemoryTaskRegistryStore({ tasks, deliveryStates: new Map() }),
      });
    };
    await withAuthenticatedTaskGateway(initializeTasks, async ({ admin, viewer }) => {
      // Keep real authorization and RPCs, but make each prepared access slice
      // consume a deterministic work budget regardless of host speed.
      let workMs = performance.now();
      let accessSliceWorkMs = 20;
      const workClock = vi.spyOn(performance, "now").mockImplementation(() => workMs);
      const prepareAccess = taskSessionAccess.prepareTaskSessionReadFilter;
      let onAccessSlice: ((batch: Parameters<typeof prepareAccess>[1]) => void) | undefined;
      const accessWork = vi
        .spyOn(taskSessionAccess, "prepareTaskSessionReadFilter")
        .mockImplementation((...args) => {
          const filter = prepareAccess(...args);
          onAccessSlice?.(args[1]);
          workMs += accessSliceWorkMs;
          return filter;
        });
      const sortedInputLengths: number[] = [];
      const originalToSorted = Array.prototype.toSorted;
      const sortSpy = vi.spyOn(Array.prototype, "toSorted").mockImplementation(function <T>(
        this: T[],
        compareFn?: (left: T, right: T) => number,
      ): T[] {
        const first = this[0];
        if (first && typeof first === "object" && "taskId" in first) {
          sortedInputLengths.push(this.length);
        }
        return Reflect.apply(originalToSorted, this, [compareFn]) as T[];
      });
      let pendingMutation: ReturnType<typeof setImmediate> | undefined;
      try {
        let mutationsApplied = false;
        // Mutate once at the scan's first yield, not on every persistence read.
        onAccessSlice = () => {
          onAccessSlice = undefined;
          pendingMutation = setImmediate(() => {
            const updated = markTaskTerminalById({
              taskId: updatedTask.taskId,
              status: "succeeded",
              endedAt: TASK_COUNT + 1,
              lastEventAt: TASK_COUNT + 1,
            });
            const current = getTaskRegistryStore().loadSnapshot().tasks.get(changedTaskId);
            if (!current) {
              throw new Error("Expected the selected task before metadata publication");
            }
            const changed = { ...current, task: "Changed during scan" };
            getTaskRegistryStore().upsertTaskWithDeliveryState({ task: changed });
            publishTaskRecordAfterAtomicStore(changed);
            const created = createTaskRecord({
              runtime: "cli",
              requesterSessionKey: OWNED_SESSION_KEY,
              requesterAgentId: "main",
              ownerKey: OWNED_SESSION_KEY,
              scopeKind: "session",
              runId: "run-created-during-scan",
              task: "Created during scan",
              status: "running",
              deliveryStatus: "pending",
              lastEventAt: TASK_COUNT + 2,
            });
            mutationsApplied = updated !== null && created !== null;
          });
        };
        const listPromise = sendRpc<TasksListResult>(admin, "tasks-list", "tasks.list", {
          limit: 7,
        });
        const list = await listPromise;

        const listMaxSortedInput = Math.max(0, ...sortedInputLengths);
        const persistedTasks = getTaskRegistryStore().loadSnapshot().tasks;
        expect(persistedTasks.get(changedTaskId)?.task).toBe("Changed during scan");
        expect(persistedTasks.get(updatedTask.taskId)).toMatchObject({
          endedAt: TASK_COUNT + 1,
          lastEventAt: TASK_COUNT + 1,
        });
        expect(
          [...persistedTasks.values()].some((task) => task.runId === "run-created-during-scan"),
        ).toBe(true);
        const currentTasks = listTaskRecords();
        expect(currentTasks).toHaveLength(TASK_COUNT + 1);
        const adminExpected = expectedTaskIds(currentTasks, 0, 7);
        expect(mutationsApplied).toBe(true);
        expect(list.ok, JSON.stringify(list.error)).toBe(true);
        expect(list.payload?.tasks.map((task) => task.id)).toEqual(adminExpected);
        expect(list.payload?.nextCursor).toEqual(expect.any(String));
        expect(listMaxSortedInput).toBeLessThanOrEqual(7);
        const cursor = list.payload?.nextCursor;
        if (!cursor) {
          throw new Error("expected an admin task cursor");
        }
        const tamperedCursor = cursor.split(".");
        tamperedCursor[1] = "1";
        await expectCursorRejected(admin, "tasks-offset-mismatch", {
          cursor: tamperedCursor.join("."),
          limit: 7,
        });
        const completed = persistedTasks.get(updatedTask.taskId);
        if (!completed || completed.cleanupAfter === undefined) {
          throw new Error("Expected the completed task's retention deadline");
        }
        expect(
          await applyTaskRegistryMaintenanceRetention(
            completed,
            completed.cleanupAfter + 1,
            new Map(),
            () => {},
          ),
        ).toBe("pruned");
        const revisionCursor = cursor.split(".");
        revisionCursor[2] = String(Number(revisionCursor[2]) + 1);
        await expectCursorRejected(admin, "tasks-revision-mismatch", {
          cursor: revisionCursor.join("."),
          limit: 7,
        });
        await expectCursorRejected(admin, "tasks-status-mismatch", {
          cursor,
          limit: 7,
          status: "running",
        });
        await expectCursorRejected(admin, "tasks-agent-mismatch", {
          agentId: "worker",
          cursor,
          limit: 7,
        });
        await expectCursorRejected(viewer, "tasks-connection-mismatch", { cursor, limit: 7 });
        await expectCursorRejected(admin, "tasks-noncanonical", {
          cursor: `${cursor}=`,
          limit: 7,
        });
        await expectCursorRejected(admin, "tasks-oversized", {
          cursor: "x".repeat(TASKS_LIST_CURSOR_MAX_LENGTH + 1),
          limit: 7,
        });
        const viewerExpected = expectedTaskIds(
          listTaskRecords().filter((task) => task.requesterSessionKey === OWNED_SESSION_KEY),
          0,
          25,
        );
        const sessionPage = await sendRpc<TasksListResult>(
          admin,
          "tasks-session-page",
          "tasks.list",
          { limit: 1, sessionKey: OWNED_SESSION_KEY },
        );
        expect(sessionPage.ok, JSON.stringify(sessionPage.error)).toBe(true);
        expect(sessionPage.payload?.tasks.map((task) => task.id)).toEqual(
          viewerExpected.slice(0, 1),
        );
        const sessionCursor = sessionPage.payload?.nextCursor;
        if (!sessionCursor) {
          throw new Error("expected a session task cursor");
        }
        await expectCursorRejected(admin, "tasks-session-mismatch", {
          cursor: sessionCursor,
          limit: 1,
          sessionKey: FOREIGN_SESSION_KEY,
        });

        sortedInputLengths.length = 0;
        const accessOrder: string[] = [];
        const taskRuntime = await import("../tasks/runtime-internal.js");
        const selectPage = taskRuntime.listTaskRecordPage;
        let visibility: RpcResponse<Record<string, unknown>> | undefined;
        // Hold one completed selection until the real sharing RPC commits; the handler
        // must reject that stale page and select again with current access.
        const pageSelections = vi
          .spyOn(taskRuntime, "listTaskRecordPage")
          .mockImplementationOnce(async (params) => {
            const page = await selectPage(params);
            visibility = await sendRpc<Record<string, unknown>>(
              admin,
              "session-visibility",
              "session.visibility.set",
              {
                sessionKey: FOREIGN_SESSION_KEY,
                agentId: "main",
                visibility: "draft",
              },
            );
            accessOrder.push("visibility");
            return page;
          });
        try {
          const restricted = await sendRpc<TasksListResult>(viewer, "tasks-owned", "tasks.list", {
            limit: 25,
          }).then((response) => {
            accessOrder.push("tasks.list");
            return response;
          });
          expect(visibility?.ok, JSON.stringify(visibility?.error)).toBe(true);
          expect(restricted.ok, JSON.stringify(restricted.error)).toBe(true);
          expect(restricted.payload?.tasks.map((task) => task.id)).toEqual(viewerExpected);
          expect(restricted.payload?.tasks).toHaveLength(25);
          expect(
            restricted.payload?.tasks.every((task) => task.sessionKey === OWNED_SESSION_KEY),
          ).toBe(true);
          expect(restricted.payload?.nextCursor).toEqual(expect.any(String));
          expect(accessOrder[0]).toBe("visibility");
          expect(Math.max(0, ...sortedInputLengths)).toBeLessThanOrEqual(25);
          expect(pageSelections).toHaveBeenCalledTimes(2);
        } finally {
          pageSelections.mockRestore();
        }
        const accessCursor = sessionCursor.split(".");
        accessCursor[3] = String(Number(accessCursor[3]) + 1);
        await expectCursorRejected(admin, "tasks-access-revision", {
          cursor: accessCursor.join("."),
          limit: 1,
          sessionKey: OWNED_SESSION_KEY,
        });

        const convergingTasks = createTaskSnapshot();
        const convergingTaskId = convergingTasks.keys().next().value;
        if (!convergingTaskId) {
          throw new Error("expected a converging task fixture");
        }
        let convergingRevision = 0;
        const convergingRevisionTarget = 1;
        configureTaskRegistryRuntime({
          store: createInMemoryTaskRegistryStore({
            tasks: convergingTasks,
            deliveryStates: new Map(),
          }),
        });
        await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
        onAccessSlice = () => {
          onAccessSlice = undefined;
          pendingMutation = setImmediate(() => {
            convergingRevision += 1;
            markTaskTerminalById({
              taskId: convergingTaskId,
              status: "succeeded",
              endedAt: TASK_COUNT + convergingRevision,
            });
          });
        };
        const convergedRegistry = await sendRpc<TasksListResult>(
          admin,
          "tasks-converged-registry",
          "tasks.list",
          { limit: 1 },
        );
        expect(convergingRevision).toBe(convergingRevisionTarget);
        expect(convergedRegistry.ok, JSON.stringify(convergedRegistry.error)).toBe(true);
        expect(convergedRegistry.payload?.tasks).toHaveLength(1);

        for (const { sliceWorkMs, expectedQueuedWork } of [
          { sliceWorkMs: 1, expectedQueuedWork: [false, false, false] },
          { sliceWorkMs: 3, expectedQueuedWork: [false, true, true] },
        ]) {
          const retryTasks = new Map([...createTaskSnapshot()].slice(0, 65));
          configureTaskRegistryRuntime({
            store: createInMemoryTaskRegistryStore({
              tasks: retryTasks,
              deliveryStates: new Map(),
            }),
          });
          await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
          let preparations = 0;
          let mutations = 0;
          let retryCandidates = 0;
          let queuedWorkRan = false;
          let queuedWork: ReturnType<typeof setImmediate> | undefined;
          const queuedWorkDuringRetry: boolean[] = [];
          const createPreparation = taskRegistryRead.createTaskRegistryReadPreparation;
          const preparation = vi
            .spyOn(taskRegistryRead, "createTaskRegistryReadPreparation")
            .mockImplementation(() => {
              const prepareRead = createPreparation();
              return async () => {
                const read = await prepareRead();
                preparations += 1;
                if (preparations === 2) {
                  // Preparation elapsed time must not consume the scan's work budget.
                  workMs += 100;
                  queuedWork = setImmediate(() => {
                    queuedWorkRan = true;
                  });
                }
                return read;
              };
            });
          accessSliceWorkMs = sliceWorkMs;
          onAccessSlice = (batch) => {
            if (preparations === 1 && mutations === 0) {
              const updated = markTaskTerminalById({
                taskId: "task-00064",
                status: "succeeded",
                endedAt: TASK_COUNT + 1,
                lastEventAt: TASK_COUNT + 1,
              });
              if (!updated) {
                throw new Error("expected a task completion during page selection");
              }
              retryTasks.set(updated.taskId, updated);
              mutations += 1;
            }
            if (preparations === 2 && retryCandidates < retryTasks.size) {
              queuedWorkDuringRetry.push(queuedWorkRan);
              retryCandidates += batch.length;
            }
          };
          const sortedBeforeRetry = sortedInputLengths.length;
          try {
            const retriedPage = await sendRpc<TasksListResult>(
              viewer,
              `tasks-retry-budget-${sliceWorkMs}`,
              "tasks.list",
              { limit: 7 },
            );
            expect(retriedPage.ok, JSON.stringify(retriedPage.error)).toBe(true);
            expect(preparations).toBe(2);
            expect(mutations).toBe(1);
            expect(queuedWorkDuringRetry).toEqual(expectedQueuedWork);
            expect(sortedInputLengths.slice(sortedBeforeRetry).every((size) => size <= 7)).toBe(
              true,
            );
            const visibleTasks = [...retryTasks.values()].filter(
              (task) => task.requesterSessionKey === OWNED_SESSION_KEY,
            );
            expect(retriedPage.payload?.tasks.map((task) => task.id)).toEqual(
              expectedTaskIds(visibleTasks, 0, 7),
            );
            expect(retriedPage.payload?.tasks[0]?.id).toBe("task-00064");
            expect(retriedPage.payload?.nextCursor).toBeDefined();
          } finally {
            clearImmediate(queuedWork);
            onAccessSlice = undefined;
            accessSliceWorkMs = 20;
            preparation.mockRestore();
          }
        }

        const churnTasks = createTaskSnapshot();
        const churnTaskId = churnTasks.keys().next().value;
        if (!churnTaskId) {
          throw new Error("expected a task churn fixture");
        }
        configureTaskRegistryRuntime({
          store: createInMemoryTaskRegistryStore({
            tasks: churnTasks,
            deliveryStates: new Map(),
          }),
        });
        await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
        let taskChurnRevision = 0;
        const registrySelections = vi.spyOn(taskRuntime, "listTaskRecordPage");
        // Invalidate each scan when it reads the fixture task. Counting free-running
        // callbacks does not prove that any mutation invalidated the selected page.
        onAccessSlice = (batch) => {
          if (!batch.some((task) => task.taskId === churnTaskId)) {
            return;
          }
          taskChurnRevision += 1;
          const endedAt = TASK_COUNT + 100 + taskChurnRevision;
          expect(
            markTaskTerminalById({ taskId: churnTaskId, status: "succeeded", endedAt })?.endedAt,
          ).toBe(endedAt);
        };
        try {
          const unstableRegistry = await sendRpc<Record<string, unknown>>(
            admin,
            "tasks-unstable-registry",
            "tasks.list",
            { limit: 1 },
          );
          expect(taskChurnRevision).toBeGreaterThanOrEqual(3);
          expect(registrySelections).toHaveBeenCalledTimes(3);
          expect(unstableRegistry).toMatchObject({
            ok: false,
            error: {
              code: "UNAVAILABLE",
              message: "Task activity did not stabilize. Wait a moment, then refresh Tasks.",
              retryable: true,
              retryAfterMs: 250,
            },
          });
        } finally {
          onAccessSlice = undefined;
          registrySelections.mockRestore();
        }

        const scopedTasks = new Map(
          [...createTaskSnapshot()].slice(0, 65).map(([taskId, task], index) => {
            const requesterSessionKey = index === 0 ? OWNED_SESSION_KEY : FOREIGN_SESSION_KEY;
            return [taskId, { ...task, requesterSessionKey, ownerKey: requesterSessionKey }];
          }),
        );
        let scopedRevision = 0;
        let scopedRevisionAtStop = 0;
        let scopedChurn: Promise<void> | undefined;
        let scopedChurnStopped = false;
        const mutateUnrelatedTask = async () => {
          for (;;) {
            await new Promise<void>((resolve) => {
              setImmediate(resolve);
            });
            if (scopedChurnStopped) {
              return;
            }
            scopedRevision += 1;
            markTaskTerminalById({
              taskId: "task-00064",
              status: "succeeded",
              endedAt: TASK_COUNT + scopedRevision,
            });
          }
        };
        const scopedStore = createInMemoryTaskRegistryStore({
          tasks: scopedTasks,
          deliveryStates: new Map(),
        });
        configureTaskRegistryRuntime({
          store: {
            ...scopedStore,
            loadSnapshot: () => {
              scopedChurn ??= mutateUnrelatedTask();
              return scopedStore.loadSnapshot();
            },
          },
        });
        try {
          await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
          // Repeated snapshot reads must share the fixture's one owned churn loop.
          getTaskRegistryStore().loadSnapshot();
          const scopedPage = await sendRpc<TasksListResult>(viewer, "tasks-scoped", "tasks.list", {
            sessionKey: OWNED_SESSION_KEY,
            agentId: "main",
            limit: 1,
          });
          expect(scopedPage.ok, JSON.stringify(scopedPage.error)).toBe(true);
          expect(scopedPage.payload?.tasks.map((task) => task.id)).toEqual(["task-00000"]);
          expect(scopedPage.payload?.nextCursor).toBeUndefined();
        } finally {
          scopedChurnStopped = true;
          scopedRevisionAtStop = scopedRevision;
          await scopedChurn;
        }

        const accessTasks = new Map([...createTaskSnapshot()].slice(0, 1_000));
        configureTaskRegistryRuntime({
          store: createInMemoryTaskRegistryStore({ tasks: accessTasks, deliveryStates: new Map() }),
        });
        await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
        let accessMutationCount = 0;
        // Invalidate every completed page before the handler checks access again.
        // A free-running RPC loop can leave a stable gap between its writes.
        const accessChurn = vi
          .spyOn(taskRuntime, "listTaskRecordPage")
          .mockImplementation(async (params) => {
            const page = await selectPage(params);
            const response = await sendRpc<Record<string, unknown>>(
              admin,
              `visibility-churn-${accessMutationCount}`,
              "session.visibility.set",
              {
                sessionKey: FOREIGN_SESSION_KEY,
                agentId: "main",
                visibility: accessMutationCount % 2 === 0 ? "shared" : "draft",
              },
            );
            expect(response.ok, JSON.stringify(response.error)).toBe(true);
            accessMutationCount += 1;
            return page;
          });
        try {
          const unstableAccess = await sendRpc<Record<string, unknown>>(
            viewer,
            "tasks-unstable-access",
            "tasks.list",
            { limit: 1 },
          );
          expect(accessMutationCount).toBe(3);
          expect(unstableAccess).toMatchObject({
            ok: false,
            error: {
              code: "UNAVAILABLE",
              message: "Task activity did not stabilize. Wait a moment, then refresh Tasks.",
              retryable: true,
              retryAfterMs: 250,
            },
          });
        } finally {
          accessChurn.mockRestore();
        }
        expect(scopedRevision, "scoped task fixture must stop before later task fixtures").toBe(
          scopedRevisionAtStop,
        );
      } finally {
        clearImmediate(pendingMutation);
        sortSpy.mockRestore();
        accessWork.mockRestore();
        workClock.mockRestore();
      }
    });
  }, 60_000);
});
