import { StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import * as stateReads from "../../state/openclaw-state-db-readonly.js";
import { createSubagentTaskBackingDetail } from "../../tasks/task-backing-records.js";
import { updateTask } from "../../tasks/task-registry-mutation.js";
import { publishTaskRecordAfterAtomicStore } from "../../tasks/task-registry-publication.js";
import { getTaskById, resetTaskRegistryForTests } from "../../tasks/task-registry-query.js";
import * as taskReads from "../../tasks/task-registry-read.js";
import { markTaskTerminalById } from "../../tasks/task-registry-record-api.js";
import { emitTaskRegistryObserverEvent } from "../../tasks/task-registry-state.js";
import { configureTaskRegistryRuntime } from "../../tasks/task-registry.store.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createInMemoryTaskRegistryStore } from "../../test-utils/task-registry-store.js";
import { createSubagentRunRecord } from "../subagent-test-fixtures.test-helpers.js";
import {
  clearSubagentRunsReadCacheForTest,
  persistSubagentRunsToDiskOrThrow,
  prepareSubagentSessionListReadCache,
  withSubagentRunReadSnapshot,
} from "../subagents/registry/subagent-registry-state.js";
import { saveSubagentRegistryToSqlite } from "../subagents/registry/subagent-registry.store.sqlite.js";
import { createSubagentsTool } from "./subagents-tool.js";

it("keeps persisted subagent wait selection off the calling thread", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
    async () => {
      const ownerKey = "agent:main:main";
      const childKey = "agent:main:subagent:persisted-wait";
      const run = createSubagentRunRecord({
        runId: "physical-run",
        taskRunId: "logical-run",
        generation: 1,
        childSessionKey: childKey,
        requesterSessionKey: ownerKey,
        requesterAgentId: "main",
        completion: { required: false },
        delivery: { status: "not_required" },
      });
      persistSubagentRunsToDiskOrThrow(new Map([[run.runId, run]]));
      clearSubagentRunsReadCacheForTest();
      const selected: TaskRecord = {
        taskId: "selected-native-task",
        runId: "logical-run",
        runtime: "subagent",
        ownerKey,
        requesterSessionKey: ownerKey,
        requesterAgentId: "main",
        childSessionKey: childKey,
        scopeKind: "session",
        task: "Synthetic persisted wait",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: 1,
        detail: createSubagentTaskBackingDetail(1),
      };
      configureTaskRegistryRuntime({
        store: createInMemoryTaskRegistryStore({
          tasks: new Map([[selected.taskId, selected]]),
          deliveryStates: new Map(),
        }),
      });
      let registryReads = 0;
      const statements = (["get", "all", "iterate"] as const).map((method) => {
        const execute = StatementSync.prototype[method];
        return vi.spyOn(StatementSync.prototype, method).mockImplementation(function (
          this: StatementSync,
          ...args: unknown[]
        ) {
          if (/\bfrom\s+"?subagent_runs\b/i.test(this.sourceSQL)) {
            registryReads++;
          }
          return Reflect.apply(execute, this, args);
        });
      });
      try {
        const result = await createSubagentsTool({ agentSessionKey: ownerKey, config: {} }).execute(
          "wait",
          { action: "wait", taskIds: [selected.taskId], timeoutSeconds: 0 },
        );
        expect(result.details).toMatchObject({
          reason: "timeout",
          tasks: [{ taskId: selected.taskId }],
        });
        expect(registryReads).toBe(0);
      } finally {
        for (const statement of statements) {
          statement.mockRestore();
        }
        resetTaskRegistryForTests();
        clearSubagentRunsReadCacheForTest();
      }
    },
  );
});

it.each([
  "task preparation",
  "task publication",
  "deadline",
  "abort",
  "abort with cleanup failure",
] as const)("joins compact recovery before wait selection after %s", async (trigger) => {
  await withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
    async () => {
      clearSubagentRunsReadCacheForTest();
      const ownerKey = "agent:main:main";
      const run = createSubagentRunRecord({
        runId: "selected-run",
        taskRunId: "selected-logical-run",
        childSessionKey: "agent:main:subagent:selected",
        requesterSessionKey: ownerKey,
        requesterAgentId: "main",
        generation: 1,
        completion: { required: false },
        delivery: { status: "not_required" },
      });
      const previous = {
        ...run,
        runId: "previous-run",
        childSessionKey: "agent:main:subagent:recovering",
      };
      saveSubagentRegistryToSqlite(new Map([run, previous].map((entry) => [entry.runId, entry])));
      await prepareSubagentSessionListReadCache();
      const selected: TaskRecord = {
        taskId: "selected-task",
        runId: run.taskRunId,
        runtime: "subagent",
        ownerKey,
        requesterSessionKey: ownerKey,
        requesterAgentId: "main",
        childSessionKey: run.childSessionKey,
        scopeKind: "session",
        task: "Wait through compact recovery",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: 1,
        detail: createSubagentTaskBackingDetail(1),
      };
      configureTaskRegistryRuntime({
        store: createInMemoryTaskRegistryStore({
          tasks: new Map([[selected.taskId, selected]]),
          deliveryStates: new Map(),
        }),
      });
      const taskPrepared = createDeferred();
      const firstSelection = createDeferred();
      const releaseTaskPreparation = createDeferred();
      const prepareTasks = taskReads.prepareTaskRegistryRead;
      const taskRead = vi
        .spyOn(taskReads, "prepareTaskRegistryRead")
        .mockImplementation(async (...args) => {
          const prepared = await prepareTasks(...args);
          if (prepared) {
            const select = prepared.listTaskRecordsWithAncestors;
            prepared.listTaskRecordsWithAncestors = (...selection) => {
              const tasks = select(...selection);
              firstSelection.resolve();
              return tasks;
            };
          }
          taskPrepared.resolve();
          if (trigger === "task preparation") {
            await releaseTaskPreparation.promise;
          }
          return prepared;
        });
      const recoveryStarted = createDeferred();
      const releaseRecovery = createDeferred();
      const failure =
        trigger === "abort with cleanup failure"
          ? new AggregateError(
              [new Error("query failed"), new Error("cleanup failed")],
              "read cleanup failed",
            )
          : undefined;
      const executeRead = stateReads.executeExistingOpenClawStateRead;
      const read = vi
        .spyOn(stateReads, "executeExistingOpenClawStateRead")
        .mockImplementation(async (...args) => {
          const result = await executeRead(...args);
          if (args[1].type === "subagents.sessionList") {
            recoveryStarted.resolve();
            await releaseRecovery.promise;
            if (failure) {
              throw failure;
            }
          }
          return result;
        });
      if (trigger === "deadline") {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      }
      const abort = new AbortController();
      const waiting = createSubagentsTool({ agentSessionKey: ownerKey, config: {} }).execute(
        "wait",
        {
          action: "wait",
          taskIds: [selected.taskId],
          timeoutSeconds: trigger === "task preparation" ? 0 : trigger === "deadline" ? 1 : 60,
        },
        abort.signal,
      );
      let settled: { result: Awaited<typeof waiting> } | { error: unknown } | undefined;
      const outcome = waiting.then(
        (result) => (settled = { result }),
        (error: unknown) => (settled = { error }),
      );
      let recovery: Promise<unknown> | undefined;
      try {
        await (trigger === "task preparation" ? taskPrepared.promise : firstSelection.promise);
        const replacement = { ...previous, runId: "replacement-run", generation: 2 };
        saveSubagentRegistryToSqlite(
          new Map([run, replacement].map((entry) => [entry.runId, entry])),
        );
        recovery = withSubagentRunReadSnapshot(
          new Map(),
          (snapshot) => ({
            runIds: [...snapshot.values()]
              .filter((entry) => entry.childSessionKey === previous.childSessionKey)
              .map((entry) => entry.runId),
            sessionKeys: [],
          }),
          (selection) => selection.runIds,
        ).catch((error: unknown) => error);
        await recoveryStarted.promise;
        if (trigger === "task preparation") {
          releaseTaskPreparation.resolve();
        } else if (trigger === "deadline") {
          await vi.advanceTimersByTimeAsync(1_000);
        } else {
          const publisher = new AsyncWorkScope();
          publisher.run(() => {
            markTaskTerminalById({
              taskId: selected.taskId,
              status: "succeeded",
              endedAt: Date.now(),
            });
          });
          await publisher.drain();
        }
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        if (trigger === "abort" || trigger === "abort with cleanup failure") {
          abort.abort();
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
        }
        expect(settled).toBeUndefined();
        releaseRecovery.resolve();
        const observed = await outcome;
        if (failure) {
          expect(observed).toEqual({ error: failure });
          expect(await recovery).toBe(failure);
        } else {
          expect(await recovery).toEqual([replacement.runId]);
          if (trigger === "abort") {
            expect(observed).toMatchObject({ error: { name: "AbortError" } });
          } else {
            expect(observed).toMatchObject({
              result: {
                details: {
                  reason: trigger === "task publication" ? "completed" : "timeout",
                  tasks: [{ taskId: selected.taskId }],
                  completed: trigger === "task publication" ? [selected.taskId] : [],
                },
              },
            });
          }
        }
        expect(
          read.mock.calls.filter(([, command]) => command.type === "subagents.sessionList"),
        ).toHaveLength(1);
      } finally {
        releaseTaskPreparation.resolve();
        releaseRecovery.resolve();
        abort.abort();
        await Promise.allSettled([waiting, recovery]);
        taskRead.mockRestore();
        read.mockRestore();
        vi.useRealTimers();
        resetTaskRegistryForTests();
        clearSubagentRunsReadCacheForTest();
      }
    },
  );
});

it.each(["completion", "reparent", "broad", "agent-collision"] as const)(
  "scopes descendant waits across unrelated publications and %s",
  async (transition) => {
    const ownerKey = "agent:main:main";
    const childKey = "agent:main:child";
    const record = (taskId: string, owner: string): TaskRecord => ({
      taskId,
      runtime: "cli",
      ownerKey: owner,
      requesterSessionKey: owner,
      scopeKind: "session",
      task: taskId,
      status: "queued",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      createdAt: 1,
    });
    const unrelated = {
      ...record("unrelated", "agent:main:other"),
      detail: { unrelated: true, payload: "unrelated retained runtime detail" },
    };
    const selected = {
      ...record("selected", transition === "agent-collision" ? ownerKey : childKey),
      detail: { selected: true },
      ...(transition === "agent-collision" ? { requesterAgentId: "other" } : {}),
    };
    const sibling = { ...record("sibling", ownerKey), detail: { unrelated: true } };
    const parent = {
      ...record("parent", ownerKey),
      childSessionKey: transition === "agent-collision" ? ownerKey : childKey,
      ...(transition === "agent-collision" ? { agentId: "other" } : {}),
    };
    configureTaskRegistryRuntime({
      store: createInMemoryTaskRegistryStore({
        tasks: new Map([selected, unrelated, parent, sibling].map((task) => [task.taskId, task])),
        deliveryStates: new Map(),
      }),
    });
    getTaskById(selected.taskId);
    const firstRead = createDeferred();
    const originalClone = globalThis.structuredClone;
    const clone = vi.spyOn(globalThis, "structuredClone").mockImplementation((value, options) => {
      if (value && typeof value === "object" && "selected" in value) {
        firstRead.resolve();
      }
      return originalClone(value, options);
    });
    const tool = createSubagentsTool({ agentSessionKey: ownerKey, config: {} });
    const abort = new AbortController();
    const waiting = tool.execute(
      "wait",
      { action: "wait", taskIds: [selected.taskId] },
      abort.signal,
    );
    try {
      await firstRead.promise;
      expect(clone).not.toHaveBeenCalledWith(expect.objectContaining({ unrelated: true }));
      clone.mockClear();
      emitTaskRegistryObserverEvent(() => ({ kind: "upserted", task: unrelated }));
      emitTaskRegistryObserverEvent(() => ({ kind: "upserted", task: sibling }));
      await Promise.resolve();
      expect(clone).not.toHaveBeenCalled();
      if (transition === "reparent") {
        updateTask(parent.taskId, { childSessionKey: "agent:main:different-child" });
        expect((await waiting).details).toMatchObject({
          reason: "unavailable",
          unavailable: [selected.taskId],
          tasks: [],
        });
        // Atomic publications must rebind the same ancestry index as ordinary mutations.
        publishTaskRecordAfterAtomicStore(parent);
        expect(
          (
            await tool.execute("snapshot", {
              action: "wait",
              taskIds: [selected.taskId],
              timeoutSeconds: 0,
            })
          ).details,
        ).toMatchObject({ reason: "timeout", tasks: [{ taskId: selected.taskId }] });
        return;
      }
      if (transition === "broad") {
        emitTaskRegistryObserverEvent(() => ({ kind: "restored" }));
        await Promise.resolve();
        expect(clone).toHaveBeenCalledWith(expect.objectContaining({ selected: true }));
      }
      markTaskTerminalById({ taskId: selected.taskId, status: "succeeded", endedAt: Date.now() });
      expect((await waiting).details).toMatchObject({
        reason: "completed",
        completed: [selected.taskId],
        tasks: [{ taskId: selected.taskId, deliveryStatus: "not_applicable" }],
      });
      expect(clone).not.toHaveBeenCalledWith(expect.objectContaining({ unrelated: true }));
    } finally {
      abort.abort();
      await waiting.catch(() => {});
      clone.mockRestore();
      resetTaskRegistryForTests();
    }
  },
);
