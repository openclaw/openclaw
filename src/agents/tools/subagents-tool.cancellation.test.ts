import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { registerActiveCronTaskRun } from "../../cron/service/active-run-cancellation.js";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import { getDetachedTaskLifecycleRuntime } from "../../tasks/detached-task-runtime.js";
import {
  resetDetachedTaskLifecycleRuntimeForTests,
  setDetachedTaskLifecycleRuntime,
} from "../../tasks/detached-task-runtime.test-support.js";
import { createSubagentTaskBackingDetail } from "../../tasks/task-backing-records.js";
import { resetTaskFlowRegistryForTests } from "../../tasks/task-flow-registry.test-support.js";
import { getTaskById } from "../../tasks/task-registry.js";
import {
  createTaskFixture,
  resetTaskRegistryForTests,
} from "../../tasks/task-registry.test-support.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../subagents/registry/subagent-registry.test-helpers.js";
import { createSubagentsTool } from "./subagents-tool.js";

describe("subagents cancellation authority", () => {
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
