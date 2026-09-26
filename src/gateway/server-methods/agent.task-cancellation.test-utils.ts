import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  prepareTaskCancellationControl,
  withTaskCancellationContext,
  withTaskCancellationControl,
} from "../../tasks/task-cancellation-context.js";
import { cancelDetachedTaskRunById } from "../../tasks/task-executor.js";
import { reloadTaskRegistryFromStoreAsync } from "../../tasks/task-registry-state.js";
import {
  createTaskRecord,
  findTaskByRunId,
  markTaskTerminalById,
} from "../../tasks/task-registry.js";
import { getTaskRunOwner } from "../../tasks/task-run-owner.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { removeChatAbortControllerEntry } from "../chat-abort.js";
import {
  expectRecordFields,
  getAgentTestMocks,
  invokeAgent,
  makeContext,
  primeMainAgentRun,
  requireValue,
  resetAgentTaskRegistryForTests,
  useTestStateDir,
  waitForAssertion,
} from "./agent.test-harness.js";
import { runTaskHandler } from "./tasks.test-helpers.js";

export function registerAgentTaskCancellationTests() {
  const mocks = getAgentTestMocks();

  it.each([
    { route: "gateway", aborted: true, status: "cancelled" },
    { route: "shared owner", aborted: true, status: "cancelled" },
    { route: "gateway", aborted: false, status: "succeeded" },
    { route: "shared owner", aborted: false, status: "succeeded" },
  ] as const)(
    "waits for the ordinary task producer through $route after a store reload before reporting $status",
    async ({ route, aborted, status }) => {
      await withTestDir({ prefix: "openclaw-agent-task-cancellation-" }, async (root) => {
        useTestStateDir(root);
        resetAgentTaskRegistryForTests();
        primeMainAgentRun();
        const run = createDeferred<{
          payloads: [];
          meta: { durationMs: number; aborted: boolean; stopReason: string };
        }>();
        mocks.agentCommand.mockReturnValueOnce(run.promise);
        const context = makeContext();
        context.cancelRunBoundApprovals = vi.fn();
        const runId = `task-cancellation-${route}`;
        await invokeAgent(
          {
            message: "Keep working until cancelled.",
            sessionKey: "agent:main:main",
            idempotencyKey: runId,
          },
          { context, reqId: runId },
        );
        const task = requireValue(findTaskByRunId(runId), "tracked task missing");
        await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
        const entry = requireValue(context.chatAbortControllers.get(runId), "run owner missing");
        const reason = "Stop this selected work.";
        const cancellation =
          route === "gateway"
            ? runTaskHandler(
                "tasks.cancel",
                { taskId: task.taskId, reason },
                {},
                null,
                context,
              ).then(({ payload }) => payload)
            : cancelDetachedTaskRunById({ cfg: {}, taskId: task.taskId, reason });
        let responded = false;
        void cancellation.then(() => {
          responded = true;
        });
        try {
          await waitForAssertion(() => expect(entry.controller.signal.aborted).toBe(true));
          expect(context.cancelRunBoundApprovals).toHaveBeenCalledWith(runId);
          expect(findTaskByRunId(runId)?.status).toBe("running");
          expect(responded).toBe(false);
          run.resolve({
            payloads: [],
            meta: { durationMs: 1, aborted, stopReason: aborted ? "rpc" : "stop" },
          });
          expect(await cancellation).toMatchObject({ found: true, cancelled: aborted });
          expect(findTaskByRunId(runId)).toMatchObject({
            status,
            ...(aborted ? { error: reason } : {}),
          });
        } finally {
          run.resolve({
            payloads: [],
            meta: { durationMs: 1, aborted, stopReason: aborted ? "rpc" : "stop" },
          });
          await cancellation;
          await waitForAssertion(() =>
            expect(context.dedupe.get(`agent:${runId}`)?.payload).toMatchObject({
              summary: aborted ? "aborted" : "completed",
            }),
          );
        }
      });
    },
  );

  it("rechecks caller authority before ordinary task abort without revoking accepted settlement", async () => {
    await withTestDir({ prefix: "openclaw-agent-task-caller-authority-" }, async (root) => {
      useTestStateDir(root);
      resetAgentTaskRegistryForTests();
      primeMainAgentRun();
      const run = createDeferred<{
        payloads: [];
        meta: { durationMs: number; aborted: boolean; stopReason: string };
      }>();
      mocks.agentCommand.mockReturnValueOnce(run.promise);
      const context = makeContext();
      context.cancelRunBoundApprovals = vi.fn();
      const runId = "task-cancellation-caller-authority";
      await invokeAgent(
        {
          message: "Keep this execution alive until an authorized stop.",
          sessionKey: "agent:main:main",
          idempotencyKey: runId,
        },
        { context, reqId: runId },
      );
      const task = requireValue(findTaskByRunId(runId), "tracked task missing");
      const owner = requireValue(getTaskRunOwner(task), "task owner missing");
      const entry = requireValue(context.chatAbortControllers.get(runId), "run owner missing");
      let callerAuthorized = true;
      await withTaskCancellationContext(
        () => {
          if (!callerAuthorized) {
            throw new Error("Caller no longer controls this task.");
          }
        },
        async () => {
          const control = prepareTaskCancellationControl(task);
          const releaseHandoff = createDeferred();
          const enteredOwner = createDeferred();
          const denied = withTaskCancellationControl(control, async () => {
            await releaseHandoff.promise;
            const cancellation = owner.cancel("Revoked stop");
            enteredOwner.resolve();
            return await cancellation;
          }).then(
            (value) => ({ value, error: undefined }),
            (error: unknown) => ({ value: undefined, error }),
          );
          let accepted: ReturnType<typeof owner.cancel> | undefined;
          try {
            callerAuthorized = false;
            releaseHandoff.resolve();
            await enteredOwner.promise;
            expect(entry.controller.signal.aborted).toBe(false);
            expect(context.cancelRunBoundApprovals).not.toHaveBeenCalled();
            expect(findTaskByRunId(runId)?.status).toBe("running");
            expect((await denied).error).toMatchObject({
              message: "Caller no longer controls this task.",
            });

            callerAuthorized = true;
            accepted = withTaskCancellationControl(control, () => owner.cancel("Authorized stop"));
            let responded = false;
            void accepted.then(() => {
              responded = true;
            });
            expect(entry.controller.signal.aborted).toBe(true);
            expect(context.cancelRunBoundApprovals).toHaveBeenCalledExactlyOnceWith(runId);
            callerAuthorized = false;
            await Promise.resolve();
            expect(responded).toBe(false);
            expect(findTaskByRunId(runId)?.status).toBe("running");
            run.resolve({
              payloads: [],
              meta: { durationMs: 1, aborted: true, stopReason: "rpc" },
            });
            await expect(accepted).resolves.toMatchObject({
              ok: true,
              value: { status: "cancelled", error: "Authorized stop" },
            });
          } finally {
            releaseHandoff.resolve();
            run.resolve({
              payloads: [],
              meta: {
                durationMs: 1,
                aborted: entry.controller.signal.aborted,
                stopReason: entry.controller.signal.aborted ? "rpc" : "stop",
              },
            });
            await denied;
            await accepted;
          }
        },
        { selectedTask: task },
      );
    });
  });

  it("does not confirm cancellation when its producer exceeds the settlement deadline", async () => {
    await withTestDir({ prefix: "openclaw-agent-task-cancellation-timeout-" }, async (root) => {
      useTestStateDir(root);
      resetAgentTaskRegistryForTests();
      primeMainAgentRun();
      const run = createDeferred<{
        payloads: [];
        meta: { durationMs: number; aborted: true; stopReason: "rpc" };
      }>();
      mocks.agentCommand.mockReturnValueOnce(run.promise);
      const context = makeContext();
      const runId = "task-cancellation-settlement-timeout";
      vi.useFakeTimers();
      try {
        await invokeAgent(
          {
            message: "Keep this execution pending.",
            sessionKey: "agent:main:main",
            idempotencyKey: runId,
          },
          { context, reqId: runId },
        );
        const task = requireValue(findTaskByRunId(runId), "tracked task missing");
        const entry = requireValue(context.chatAbortControllers.get(runId), "run owner missing");
        const cancellation = runTaskHandler(
          "tasks.cancel",
          { taskId: task.taskId },
          {},
          null,
          context,
        );
        await waitForAssertion(() => expect(entry.controller.signal.aborted).toBe(true));
        await vi.advanceTimersByTimeAsync(10_000);
        expect((await cancellation).payload).toMatchObject({
          found: true,
          cancelled: false,
          reason: "Task cancellation settlement timed out after 10000ms",
        });
        expect(findTaskByRunId(runId)?.status).toBe("running");
      } finally {
        run.resolve({
          payloads: [],
          meta: { durationMs: 1, aborted: true, stopReason: "rpc" },
        });
        try {
          await waitForAssertion(() => expect(findTaskByRunId(runId)?.status).toBe("cancelled"));
        } finally {
          vi.useRealTimers();
        }
      }
    });
  });

  it.each(["task scope", "session", "entry", "controller", "lifecycle", "authority"] as const)(
    "refuses ordinary task cancellation after its %s changes",
    async (changedOwner) => {
      await withTestDir({ prefix: "openclaw-agent-task-owner-" }, async (root) => {
        useTestStateDir(root);
        resetAgentTaskRegistryForTests();
        primeMainAgentRun();
        const run = createDeferred<{ payloads: []; meta: { durationMs: number } }>();
        mocks.agentCommand.mockReturnValueOnce(run.promise);
        const context = makeContext();
        const runId = `task-owner-${changedOwner}`;
        await invokeAgent(
          {
            message: "Keep this run alive.",
            sessionKey: "agent:main:main",
            idempotencyKey: runId,
          },
          { context, reqId: runId },
        );
        const task = requireValue(findTaskByRunId(runId), "tracked task missing");
        const entry = requireValue(context.chatAbortControllers.get(runId), "run owner missing");
        const originalController = entry.controller;
        let taskId = task.taskId;
        if (changedOwner === "task scope") {
          taskId = requireValue(
            createTaskRecord({
              runtime: "cli",
              ownerKey: "agent:other:main",
              scopeKind: "session",
              childSessionKey: "agent:other:main",
              runId,
              task: "Another task with copied run correlation.",
              status: "running",
              deliveryStatus: "not_applicable",
            }),
            "conflicting task missing",
          ).taskId;
        } else if (changedOwner === "session") {
          entry.sessionKey = "agent:other:main";
        } else if (changedOwner === "entry") {
          context.chatAbortControllers.set(runId, { ...entry, controller: new AbortController() });
        } else if (changedOwner === "controller") {
          entry.controller = new AbortController();
        } else if (changedOwner === "lifecycle") {
          mocks.lifecycleGeneration = "replacement-generation";
        } else {
          const authority = claimAgentRunDelegatedAuthority(
            requireValue(entry.operationalRunInstance, "operational instance missing"),
          );
          entry.agentRunDelegatedAuthority = authority;
          releaseAgentRunDelegatedAuthority(authority);
        }
        try {
          const result = await runTaskHandler("tasks.cancel", { taskId }, {}, null, context);
          expect(result.payload).toMatchObject({ found: true, cancelled: false });
          expect(originalController.signal.aborted).toBe(false);
          expect(context.chatAbortControllers.get(runId)?.controller.signal.aborted).toBe(false);
        } finally {
          run.resolve({ payloads: [], meta: { durationMs: 1 } });
          await waitForAssertion(() =>
            expect(context.dedupe.get(`agent:${runId}`)?.payload).toMatchObject({
              summary: "completed",
            }),
          );
          removeChatAbortControllerEntry(context.chatAbortControllers, runId);
        }
      });
    },
  );

  it("does not overwrite operator-cancelled async gateway agent tasks after late completion", async () => {
    await withTestDir({ prefix: "openclaw-gateway-agent-task-cancelled-" }, async (root) => {
      useTestStateDir(root);
      resetAgentTaskRegistryForTests();
      primeMainAgentRun();
      const { promise: pending, resolve: resolveRun } = createDeferred<{
        payloads: Array<{ text: string }>;
        meta: { durationMs: number };
      }>();
      mocks.agentCommand.mockReturnValueOnce(pending);

      await invokeAgent(
        {
          message: "background cli task",
          sessionKey: "agent:main:main",
          idempotencyKey: "task-registry-agent-run-cancelled",
        },
        { reqId: "task-registry-agent-run-cancelled" },
      );

      const task = requireValue(
        findTaskByRunId("task-registry-agent-run-cancelled"),
        "task missing",
      );
      expectRecordFields(task, { status: "running" });
      const cancelledAt = (task?.startedAt ?? Date.now()) + 1;
      markTaskTerminalById({
        taskId: task.taskId,
        status: "cancelled",
        endedAt: cancelledAt,
        lastEventAt: cancelledAt,
        terminalSummary: "Cancelled by operator.",
      });

      resolveRun!({ payloads: [{ text: "ok" }], meta: { durationMs: 100 } });

      await waitForAssertion(() => {
        expectRecordFields(findTaskByRunId("task-registry-agent-run-cancelled"), {
          status: "cancelled",
          endedAt: cancelledAt,
          terminalSummary: "Cancelled by operator.",
        });
      });
    });
  });
}
