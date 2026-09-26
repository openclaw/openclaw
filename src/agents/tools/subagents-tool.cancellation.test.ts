import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { registerActiveCronTaskRun } from "../../cron/service/active-run-cancellation.js";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import * as stateReads from "../../state/openclaw-state-db-readonly.js";
import { getDetachedTaskLifecycleRuntime } from "../../tasks/detached-task-runtime.js";
import {
  resetDetachedTaskLifecycleRuntimeForTests,
  setDetachedTaskLifecycleRuntime,
} from "../../tasks/detached-task-runtime.test-support.js";
import { createSubagentTaskBackingDetail } from "../../tasks/task-backing-records.js";
import { resetTaskFlowRegistryForTests } from "../../tasks/task-flow-registry.test-support.js";
import { publishTaskRecordAfterAtomicStore } from "../../tasks/task-registry-publication.js";
import { controlRuntimeLoader } from "../../tasks/task-registry-runtime-loaders.js";
import { getTaskById } from "../../tasks/task-registry.js";
import {
  createTaskFixture,
  resetTaskRegistryForTests,
} from "../../tasks/task-registry.test-support.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../subagent-test-fixtures.test-helpers.js";
import {
  clearSubagentRunsReadCacheForTest,
  prepareSubagentSessionListReadCache,
  withSubagentRunReadSnapshot,
} from "../subagents/registry/subagent-registry-state.js";
import { saveSubagentRegistryToSqlite } from "../subagents/registry/subagent-registry.store.sqlite.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../subagents/registry/subagent-registry.test-helpers.js";
import { createSubagentsTool } from "./subagents-tool.js";

describe("subagents cancellation authority", () => {
  it.each(
    (["runtime handoff", "before stop"] as const).flatMap((phase) =>
      (["unchanged", "ancestor changed", "task replaced"] as const).map((transition) => ({
        phase,
        transition,
      })),
    ),
  )(
    "joins compact recovery at $phase with $transition authority",
    async ({ phase, transition }) => {
      await withOpenClawTestState(
        { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
        async () => {
          resetAgentEventsForTest();
          resetSubagentRegistryForTests({ persist: false });
          resetTaskRegistryForTests({ persist: false });
          resetTaskFlowRegistryForTests({ persist: false });
          resetDetachedTaskLifecycleRuntimeForTests();
          const requester = "agent:main:main";
          const ancestor = createSubagentRunRecord({
            runId: "ancestor-run",
            childSessionKey: "agent:main:subagent:ancestor",
            requesterSessionKey: requester,
            requesterAgentId: "main",
            controllerSessionKey: requester,
            generation: 1,
            completion: { required: false },
            delivery: { status: "not_required" },
          });
          const previous = {
            ...ancestor,
            runId: "previous-run",
            childSessionKey: "agent:main:subagent:recovering",
          };
          saveSubagentRegistryToSqlite(
            new Map([ancestor, previous].map((entry) => [entry.runId, entry])),
          );
          await prepareSubagentSessionListReadCache();
          createTaskFixture("subagent", {
            ownerKey: requester,
            requesterSessionKey: requester,
            childSessionKey: ancestor.childSessionKey,
            runId: ancestor.runId,
            task: "Own descendant work",
            detail: createSubagentTaskBackingDetail(1),
          });
          const descendant = createTaskFixture("cron", {
            ownerKey: ancestor.childSessionKey,
            runId: "descendant-cron",
            taskKind: "cron",
            task: "Continue until cancelled",
          });
          const abort = new AbortController();
          const onAbort = vi.fn();
          abort.signal.addEventListener("abort", onAbort, { once: true });
          const unregister = registerActiveCronTaskRun({
            runId: descendant.runId,
            controller: abort,
          });
          const handoffEntered = createDeferred();
          const releaseHandoff = createDeferred();
          const runtime = getDetachedTaskLifecycleRuntime();
          setDetachedTaskLifecycleRuntime({
            ...runtime,
            cancelDetachedTaskRunById: async (params) => {
              if (phase === "runtime handoff") {
                handoffEntered.resolve();
                await releaseHandoff.promise;
              }
              return runtime.cancelDetachedTaskRunById(params);
            },
          });
          const loadControl = controlRuntimeLoader.load;
          const controlLoad = vi
            .spyOn(controlRuntimeLoader, "load")
            .mockImplementation(async () => {
              const loaded = await loadControl();
              if (phase === "before stop") {
                handoffEntered.resolve();
                await releaseHandoff.promise;
              }
              return loaded;
            });
          const recoveryStarted = createDeferred();
          const releaseRecovery = createDeferred();
          const executeRead = stateReads.executeExistingOpenClawStateRead;
          const read = vi
            .spyOn(stateReads, "executeExistingOpenClawStateRead")
            .mockImplementation(async (...args) => {
              const result = await executeRead(...args);
              if (args[1].type === "subagents.sessionList") {
                recoveryStarted.resolve();
                await releaseRecovery.promise;
              }
              return result;
            });
          const pending = createSubagentsTool({ agentSessionKey: requester, config: {} }).execute(
            "cancel-during-recovery",
            { action: "cancel", taskId: descendant.taskId },
          );
          let settled: { result: Awaited<typeof pending> } | { error: unknown } | undefined;
          const outcome = pending.then(
            (result) => (settled = { result }),
            (error: unknown) => (settled = { error }),
          );
          let recovery: Promise<unknown> | undefined;
          try {
            await Promise.race([
              handoffEntered.promise,
              pending.then(() => {
                throw new Error("Cancellation returned before its runtime handoff");
              }),
            ]);
            const replacement = { ...previous, runId: "replacement-run", generation: 2 };
            const currentAncestor =
              transition === "ancestor changed"
                ? { ...ancestor, controllerSessionKey: "agent:main:other" }
                : ancestor;
            saveSubagentRegistryToSqlite(
              new Map([currentAncestor, replacement].map((entry) => [entry.runId, entry])),
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
            );
            await recoveryStarted.promise;
            if (transition === "task replaced") {
              publishTaskRecordAfterAtomicStore({ ...descendant, runId: "replacement-cron" });
            }
            releaseHandoff.resolve();
            await new Promise<void>((resolve) => {
              setImmediate(resolve);
            });
            expect(settled).toBeUndefined();
            expect(onAbort).not.toHaveBeenCalled();
            releaseRecovery.resolve();
            expect(await recovery).toEqual([replacement.runId]);
            const observed = await outcome;
            if (transition === "unchanged") {
              expect(observed).toMatchObject({ result: { details: { status: "cancelled" } } });
              expect(onAbort).toHaveBeenCalledOnce();
              expect(getTaskById(descendant.taskId)?.status).toBe("cancelled");
            } else {
              expect(observed).toMatchObject({
                result: {
                  details: {
                    status: "error",
                    cancelled: false,
                    reason:
                      transition === "ancestor changed"
                        ? "Task outside session tree."
                        : "Task changed while cancellation was in progress.",
                  },
                },
              });
              expect(onAbort).not.toHaveBeenCalled();
              expect(getTaskById(descendant.taskId)?.status).toBe("running");
            }
          } finally {
            releaseHandoff.resolve();
            releaseRecovery.resolve();
            await Promise.allSettled([pending, recovery]);
            controlLoad.mockRestore();
            read.mockRestore();
            unregister?.();
            resetDetachedTaskLifecycleRuntimeForTests();
            resetSubagentRegistryForTests({ persist: false });
            resetTaskRegistryForTests({ persist: false });
            resetTaskFlowRegistryForTests({ persist: false });
            clearSubagentRunsReadCacheForTest();
            resetAgentEventsForTest();
          }
        },
      );
    },
  );

  it.each([
    ["rejects revocation during the registered runtime handoff", "before dispatch"],
    ["rejects revocation after core preparation but before the stop", "before stop"],
    ["settles an accepted abort after ancestor control changes", "after acceptance"],
    ["cancels descendant work while ancestor control remains current", "unchanged"],
  ] as const)("%s", async (_name, transition) => {
    await withStateDirEnv("subagents-cancellation-", async () => {
      resetAgentEventsForTest();
      resetSubagentRegistryForTests({ persist: false });
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      resetDetachedTaskLifecycleRuntimeForTests();
      const requester = "agent:main:discord:channel:requester";
      const nextController = "agent:main:main";
      const ancestorSession = "agent:main:subagent:ancestor";
      const now = Date.now();
      const registerAncestor = (generation: number, controllerSessionKey: string) => {
        const runId = `ancestor-${generation}`;
        addSubagentRunForTests({
          runId,
          childSessionKey: ancestorSession,
          controllerSessionKey,
          requesterSessionKey: requester,
          requesterDisplayKey: requester,
          requesterAgentId: "main",
          task: "Own descendant work",
          generation,
          createdAt: now + generation,
          cleanup: "keep",
          execution: { status: "running", startedAt: now + generation },
        });
        createTaskFixture("subagent", {
          ownerKey: requester,
          requesterSessionKey: requester,
          childSessionKey: ancestorSession,
          runId,
          task: "Own descendant work",
          detail: createSubagentTaskBackingDetail(generation),
        });
      };
      registerAncestor(1, requester);
      const descendant = createTaskFixture("cron", {
        ownerKey: ancestorSession,
        runId: "descendant-cron",
        taskKind: "cron",
        task: "Continue until cancelled",
      });
      const abortController = new AbortController();
      const onAbort = vi.fn(() => {
        if (transition === "after acceptance") {
          registerAncestor(2, nextController);
        }
      });
      abortController.signal.addEventListener("abort", onAbort, { once: true });
      const unregister = registerActiveCronTaskRun({
        runId: descendant.runId,
        controller: abortController,
      });
      const entered = createDeferred();
      const release = createDeferred();
      const runtime = getDetachedTaskLifecycleRuntime();
      setDetachedTaskLifecycleRuntime({
        ...runtime,
        cancelDetachedTaskRunById: async (params) => {
          entered.resolve();
          await release.promise;
          const cancellation = runtime.cancelDetachedTaskRunById(params);
          if (transition === "before stop") {
            registerAncestor(2, nextController);
          }
          return cancellation;
        },
      });
      const tool = createSubagentsTool({ agentSessionKey: requester, config: {} });
      const pending = tool.execute("cancel-in-flight", {
        action: "cancel",
        taskId: descendant.taskId,
      });
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("Cancellation returned before reaching the registered runtime.");
          }),
        ]);
        expect(abortController.signal.aborted).toBe(false);
        if (transition === "before dispatch") {
          registerAncestor(2, nextController);
          expect(
            (await tool.execute("fresh-cancel", { action: "cancel", taskId: descendant.taskId }))
              .details,
          ).toMatchObject({ status: "forbidden" });
        }
        expect(getTaskById(descendant.taskId)).toEqual(descendant);
        release.resolve();
        const result = await pending;
        if (transition === "before dispatch" || transition === "before stop") {
          expect(result.details).toMatchObject({
            status: "error",
            cancelled: false,
            reason: "Task outside session tree.",
          });
          expect(abortController.signal.aborted).toBe(false);
          expect(onAbort).not.toHaveBeenCalled();
          expect(getTaskById(descendant.taskId)).toEqual(descendant);
          expect(
            (await tool.execute("fresh-cancel", { action: "cancel", taskId: descendant.taskId }))
              .details,
          ).toMatchObject({ status: "forbidden" });
          return;
        }
        expect(result.details).toMatchObject({ status: "cancelled", cancelled: true });
        expect(abortController.signal.aborted).toBe(true);
        expect(onAbort).toHaveBeenCalledOnce();
        expect(getTaskById(descendant.taskId)).toMatchObject({
          taskId: descendant.taskId,
          runId: descendant.runId,
          ownerKey: descendant.ownerKey,
          status: "cancelled",
          error: "Cancelled by operator.",
        });
      } finally {
        release.resolve();
        await Promise.allSettled([pending]);
        unregister?.();
        resetDetachedTaskLifecycleRuntimeForTests();
        resetSubagentRegistryForTests({ persist: false });
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
        resetAgentEventsForTest();
      }
    });
  });
});
