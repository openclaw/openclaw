import { afterAll, describe, expect, test, vi } from "vitest";
import {
  TASKS_LIST_CURSOR_MAX_LENGTH,
  type TasksListResult,
} from "../../packages/gateway-protocol/src/index.js";
import * as taskRegistryRead from "../tasks/task-registry-read.js";
import {
  createTaskRecord,
  deleteTaskRecordById,
  listTaskRecords,
  markTaskTerminalById,
} from "../tasks/task-registry.js";
import {
  configureTaskRegistryRuntime,
  getTaskRegistryStore,
} from "../tasks/task-registry.store.js";
import { resetTaskRegistryForTests } from "../tasks/task-runtime.test-helpers.js";
import { createInMemoryTaskRegistryStore } from "../test-utils/task-registry-store.js";
import { installGatewayTestHooks } from "./server.auth.test-helpers.js";
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
  test("keeps authenticated task pages bounded without blocking other RPCs", async () => {
    const tasks = createTaskSnapshot();
    const ownedTasks = [...tasks.values()].filter(
      (task) => task.requesterSessionKey === OWNED_SESSION_KEY,
    );
    const initialOwnedPage = expectedTaskIds(ownedTasks, 10, 25);
    const deletedTaskId = initialOwnedPage[0];
    const updatedTask = ownedTasks.find((task) => !initialOwnedPage.includes(task.taskId));
    if (!deletedTaskId || !updatedTask) {
      throw new Error("expected selected and unselected owned task fixtures");
    }

    let onSnapshotLoad: (() => void) | undefined;
    const initializeTasks = () => {
      resetTaskRegistryForTests({ persist: false });
      configureTaskRegistryRuntime({
        store: {
          ...createInMemoryTaskRegistryStore(),
          loadSnapshot: () => {
            onSnapshotLoad?.();
            return { tasks, deliveryStates: new Map() };
          },
        },
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
      try {
        let mutationsApplied = false;
        onSnapshotLoad = () => {
          setImmediate(() => {
            const updated = markTaskTerminalById({
              taskId: updatedTask.taskId,
              status: "succeeded",
              endedAt: TASK_COUNT + 1,
              lastEventAt: TASK_COUNT + 1,
            });
            const deleted = deleteTaskRecordById(deletedTaskId);
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
            mutationsApplied = updated !== null && deleted && created !== null;
          });
        };
        const listPromise = sendRpc<TasksListResult>(admin, "tasks-list", "tasks.list", {
          limit: 7,
        });
        const list = await listPromise;

        const listMaxSortedInput = Math.max(0, ...sortedInputLengths);
        const currentTasks = listTaskRecords();
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
        expect(deleteTaskRecordById(updatedTask.taskId)).toBe(true);
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
        const sessionPage = await sendRpc<TasksListResult>(
          admin,
          "tasks-session-page",
          "tasks.list",
          { limit: 1, sessionKey: OWNED_SESSION_KEY },
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

        const viewerExpected = expectedTaskIds(
          listTaskRecords().filter((task) => task.requesterSessionKey === OWNED_SESSION_KEY),
          0,
          25,
        );
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
        resetTaskRegistryForTests({ persist: false });
        let convergingChurnStarted = false;
        let convergingRevision = 0;
        const convergingRevisionTarget = 1;
        const convergeTaskRegistry = () => {
          if (convergingRevision >= convergingRevisionTarget) {
            return;
          }
          convergingRevision += 1;
          markTaskTerminalById({
            taskId: convergingTaskId,
            status: "succeeded",
            endedAt: TASK_COUNT + convergingRevision,
          });
          setImmediate(convergeTaskRegistry);
        };
        configureTaskRegistryRuntime({
          store: {
            ...createInMemoryTaskRegistryStore(),
            loadSnapshot: () => {
              if (!convergingChurnStarted) {
                convergingChurnStarted = true;
                setImmediate(convergeTaskRegistry);
              }
              return { tasks: convergingTasks, deliveryStates: new Map() };
            },
          },
        });
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
          resetTaskRegistryForTests({ persist: false });
          configureTaskRegistryRuntime({
            store: createInMemoryTaskRegistryStore({
              tasks: retryTasks,
              deliveryStates: new Map(),
            }),
          });
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
        resetTaskRegistryForTests({ persist: false });
        configureTaskRegistryRuntime({
          store: createInMemoryTaskRegistryStore({
            tasks: churnTasks,
            deliveryStates: new Map(),
          }),
        });
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
        resetTaskRegistryForTests({ persist: false });
        configureTaskRegistryRuntime({
          store: {
            ...createInMemoryTaskRegistryStore(),
            loadSnapshot: () => {
              scopedChurn ??= mutateUnrelatedTask();
              return { tasks: scopedTasks, deliveryStates: new Map() };
            },
          },
        });
        try {
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
        resetTaskRegistryForTests({ persist: false });
        configureTaskRegistryRuntime({
          store: {
            ...createInMemoryTaskRegistryStore(),
            loadSnapshot: () => ({ tasks: accessTasks, deliveryStates: new Map() }),
          },
        });
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
        sortSpy.mockRestore();
        accessWork.mockRestore();
        workClock.mockRestore();
      }
    });
  }, 60_000);
});
