import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AgentCommandOpts } from "../../agents/command/types.js";
import type { CreatedDetachedTaskRun } from "../../tasks/detached-task-runtime-contract.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import type { TaskRunOwner } from "../../tasks/task-run-owner.types.js";
import type { ChatAbortControllerEntry } from "../chat-abort.js";
import { setGatewayDedupeEntries } from "./agent-dedupe.js";
import { dispatchAgentRunFromGateway } from "./agent-run-dispatch.js";
import { createTrackedDispatch } from "./agent-run-dispatch.test-support.js";

const mocks = vi.hoisted(() => ({
  createTaskReceipt:
    vi.fn<(params: unknown, assertCurrent: () => void) => Promise<CreatedDetachedTaskRun | null>>(),
  createRunningTaskRun: vi.fn<() => TaskRecord | null>(),
  agentCommand: vi.fn(async (options: Pick<AgentCommandOpts, "onExecutionStarted">) => {
    await options.onExecutionStarted?.();
    return { payloads: [], meta: {} };
  }),
  taskRunOwners: new Map<string, TaskRunOwner>(),
  bindTaskRunOwner: vi.fn<(task: TaskRecord, cancel: TaskRunOwner["cancel"]) => () => void>(),
  getTaskRunOwner: vi.fn<(task: TaskRecord) => TaskRunOwner | undefined>(),
  finalizeTrackedTask: vi.fn(),
  finalizeActive:
    vi.fn<
      (
        task: TaskRecord,
        terminal: Parameters<CreatedDetachedTaskRun["finalizeActive"]>[0],
        canSettle: (task: TaskRecord) => boolean,
      ) => Promise<void>
    >(),
  clearAgentRunContext: vi.fn(),
}));

vi.mock("../../commands/agent.js", () => ({
  agentCommandFromGatewayIngress: mocks.agentCommand,
}));
vi.mock("../../runtime.js", () => ({ defaultRuntime: {} }));
vi.mock("../../tasks/detached-task-runtime.js", () => ({
  prepareRunningTaskRun: (params: unknown, assertCurrent: () => void) => ({
    kind: "receipt",
    create: () => mocks.createTaskReceipt(params, assertCurrent),
  }),
  createRunningTaskRun: mocks.createRunningTaskRun,
}));
vi.mock("../../tasks/runtime-internal.js", () => ({ getTaskById: vi.fn() }));
vi.mock("../../tasks/task-flow-registry.store.sqlite.js", () => ({
  bindTaskFlowExecution: vi.fn(),
}));
vi.mock("../../tasks/task-registry.store.sqlite.js", () => ({
  bindTaskRunExecution: vi.fn(),
}));
vi.mock("../../tasks/task-run-owner.js", () => ({
  bindTaskRunOwner: mocks.bindTaskRunOwner,
  getTaskRunOwner: mocks.getTaskRunOwner,
}));
vi.mock("../server-methods/agent-task-tracking.js", () => ({
  tryFinalizeTrackedAgentTask: mocks.finalizeTrackedTask,
}));
vi.mock(import("../../infra/agent-run-registry.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  clearAgentRunContext: mocks.clearAgentRunContext,
  validateAgentRunDelegatedAuthority: () => true,
}));
vi.mock(import("../../infra/agent-events.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  isAgentEventLifecycleGenerationCurrent: () => true,
}));
vi.mock("../../agents/cron-creator-authority-context.js", () => ({
  createCronCreatorAuthorityCapability: vi.fn(),
  runWithCronCreatorAuthorityCapability: vi.fn(),
}));
vi.mock("../chat-abort-ops.js", () => ({ createChatAbortOps: vi.fn() }));
vi.mock("../chat-abort.js", () => ({ abortChatRunById: vi.fn() }));
vi.mock("./agent-dedupe.js", () => ({ setGatewayDedupeEntries: vi.fn() }));

function taskReceipt(
  task: TaskRecord,
  settleUnstarted: CreatedDetachedTaskRun["settleUnstarted"],
): CreatedDetachedTaskRun {
  return {
    task,
    async bindRunOwner(cancel, assertCurrent) {
      assertCurrent();
      const release = mocks.bindTaskRunOwner(task, cancel);
      const owner = mocks.getTaskRunOwner(task);
      if (!owner) {
        throw new Error("Expected the bound fixture task owner");
      }
      return { owner, release };
    },
    settleUnstarted,
    finalizeActive: (terminal, canSettle) => mocks.finalizeActive(task, terminal, canSettle),
  };
}

describe("Gateway dispatch task creation ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.taskRunOwners.clear();
    mocks.finalizeTrackedTask.mockReset();
    mocks.finalizeActive.mockImplementation(async (task, terminal, canSettle) => {
      if (!canSettle(task)) {
        return;
      }
      Object.assign(task, terminal);
    });
    mocks.bindTaskRunOwner.mockImplementation((task, cancel) => {
      const owner = { task, cancel };
      mocks.taskRunOwners.set(task.taskId, owner);
      return () => {
        if (mocks.taskRunOwners.get(task.taskId) === owner) {
          mocks.taskRunOwners.delete(task.taskId);
        }
      };
    });
    mocks.getTaskRunOwner.mockImplementation((task) => mocks.taskRunOwners.get(task.taskId));
    mocks.agentCommand.mockImplementation(async (options) => {
      await options.onExecutionStarted?.();
      return { payloads: [], meta: {} };
    });
  });

  it.each(["success", "failure", "cancelled"] as const)(
    "awaits the captured active terminal owner before Gateway completion (%s)",
    async (outcome) => {
      const { runId, sessionKey, context, entry, task } = createTrackedDispatch();
      const entered = createDeferred();
      const resume = createDeferred();
      const settleUnstarted = vi.fn(async () => false);
      mocks.createTaskReceipt.mockResolvedValue(taskReceipt(task, settleUnstarted));
      mocks.agentCommand.mockImplementationOnce(async (options) => {
        await options.onExecutionStarted?.();
        if (outcome === "failure") {
          throw new Error("Synthetic active run failure");
        }
        if (outcome === "cancelled") {
          entry.controller.abort();
        }
        return {
          payloads: [],
          meta: outcome === "cancelled" ? { aborted: true, stopReason: "rpc" } : {},
        };
      });
      mocks.finalizeActive.mockImplementation(async (selected, terminal, canSettle) => {
        entered.resolve();
        await resume.promise;
        if (!canSettle(selected)) {
          return;
        }
        Object.assign(selected, terminal);
      });
      const emitFinal = vi.fn();
      const onSettled = vi.fn(() => true);
      const completion = dispatchAgentRunFromGateway({
        admittedRunEntry: entry,
        assertSettlementCurrent() {},
        ingressOpts: { message: task.task, sessionKey, allowModelOverride: false },
        runId,
        dedupeKeys: [],
        abortController: entry.controller,
        cleanupAbortController: vi.fn(),
        io: { emitAcceptance: vi.fn(), emitFinal },
        context,
        taskTrackingMode: "cli",
        onSettled,
      });
      try {
        await Promise.race([entered.promise, completion]);
        expect(mocks.finalizeActive).toHaveBeenCalledOnce();
        expect(mocks.finalizeTrackedTask).not.toHaveBeenCalled();
        expect(settleUnstarted).not.toHaveBeenCalled();
        expect(emitFinal).not.toHaveBeenCalled();
        expect(onSettled).not.toHaveBeenCalled();
        resume.resolve();
        await completion;
        expect(task.status).toBe(
          outcome === "success" ? "succeeded" : outcome === "failure" ? "failed" : "cancelled",
        );
        expect(emitFinal).toHaveBeenCalledOnce();
        expect(onSettled).toHaveBeenCalledOnce();
      } finally {
        resume.resolve();
        await completion;
      }
    },
  );

  it.each(["Gateway", "same-session run", "task owner", "different-session run"] as const)(
    "rechecks active terminal authority after waiting for the %s change",
    async (replacement) => {
      const { runId, sessionKey, context, entry, task } = createTrackedDispatch();
      const entered = createDeferred();
      const resume = createDeferred();
      let gatewayCurrent = true;
      mocks.createTaskReceipt.mockResolvedValue(taskReceipt(task, async () => false));
      mocks.finalizeActive.mockImplementation(async (selected, terminal, canSettle) => {
        entered.resolve();
        await resume.promise;
        if (!canSettle(selected)) {
          return;
        }
        Object.assign(selected, terminal);
      });
      const completion = dispatchAgentRunFromGateway({
        admittedRunEntry: entry,
        assertSettlementCurrent() {
          if (!gatewayCurrent) {
            throw new Error("Gateway retired");
          }
        },
        ingressOpts: { message: task.task, sessionKey, allowModelOverride: false },
        runId,
        dedupeKeys: [],
        abortController: entry.controller,
        cleanupAbortController: vi.fn(),
        io: { emitAcceptance: vi.fn(), emitFinal: vi.fn() },
        context,
        taskTrackingMode: "cli",
      });
      try {
        await Promise.race([entered.promise, completion]);
        expect(mocks.finalizeActive).toHaveBeenCalledOnce();
        if (replacement === "Gateway") {
          gatewayCurrent = false;
        } else if (replacement === "task owner") {
          mocks.taskRunOwners.set(task.taskId, { task, cancel: vi.fn<TaskRunOwner["cancel"]>() });
        } else {
          context.chatAbortControllers.set(runId, {
            ...entry,
            controller: new AbortController(),
            operationalRunInstance: { runId, instanceId: "successor" },
            sessionKey: replacement === "different-session run" ? "agent:main:other" : sessionKey,
          });
        }
        resume.resolve();
        await completion;
        expect(task.status).toBe(replacement === "different-session run" ? "succeeded" : "running");
        expect(mocks.finalizeTrackedTask).not.toHaveBeenCalled();
        expect(setGatewayDedupeEntries).toHaveBeenCalledWith(
          expect.objectContaining({
            session: {
              sessionKey,
              sessionId: entry.sessionId,
              agentId: entry.agentId,
              lifecycleGeneration: entry.lifecycleGeneration,
            },
          }),
        );
      } finally {
        resume.resolve();
        await completion;
      }
    },
  );
  it("keeps rejected pre-dispatch results with their admitted registration", async () => {
    const { runId, sessionKey, context, entry, task } = createTrackedDispatch();
    const successor: ChatAbortControllerEntry = {
      ...entry,
      controller: new AbortController(),
      sessionId: "successor-session",
      sessionKey: "agent:main:successor-session",
      operationalRunInstance: { runId, instanceId: "successor-instance" },
    };
    context.chatAbortControllers.set(runId, successor);
    const emitFinal = vi.fn();
    await dispatchAgentRunFromGateway({
      assertCurrent() {
        if (context.chatAbortControllers.get(runId) !== entry) {
          throw new Error("Gateway run owner replaced");
        }
      },
      admittedRunEntry: entry,
      ingressOpts: { message: task.task, sessionKey, allowModelOverride: false },
      runId,
      dedupeKeys: [`agent:${runId}`],
      abortController: entry.controller,
      cleanupAbortController: vi.fn(),
      io: { emitAcceptance: vi.fn(), emitFinal },
      context,
      taskTrackingMode: "none",
    });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mocks.clearAgentRunContext).not.toHaveBeenCalled();
    expect(context.chatAbortControllers.get(runId)).toBe(successor);
    expect(setGatewayDedupeEntries).toHaveBeenCalledWith(
      expect.objectContaining({
        session: {
          sessionKey,
          sessionId: entry.sessionId,
          agentId: entry.agentId,
          lifecycleGeneration: entry.lifecycleGeneration,
        },
        entry: expect.objectContaining({ ok: false }),
      }),
    );
    expect(emitFinal).toHaveBeenCalledOnce();
  });

  it("settles cancellation when source retirement races committed task creation", async () => {
    const { runId, sessionKey, context, entry, task } = createTrackedDispatch();
    const creation = createDeferred<CreatedDetachedTaskRun>();
    let sourceCurrent = true;
    const settleUnstarted = vi.fn<CreatedDetachedTaskRun["settleUnstarted"]>(
      async (terminal, canSettle) => {
        if (!canSettle(task)) {
          return false;
        }
        Object.assign(task, terminal);
        return true;
      },
    );
    mocks.createTaskReceipt.mockReturnValue(creation.promise);
    const emitFinal = vi.fn();
    const completion = dispatchAgentRunFromGateway({
      assertCurrent() {
        if (!sourceCurrent) {
          throw new Error("operator source authority is no longer active");
        }
      },
      assertSettlementCurrent() {},
      ingressOpts: { message: task.task, sessionKey, allowModelOverride: false },
      runId,
      dedupeKeys: [`agent:${runId}`],
      admittedRunEntry: entry,
      abortController: entry.controller,
      cleanupAbortController: vi.fn(),
      io: { emitAcceptance: vi.fn(), emitFinal },
      context,
      taskTrackingMode: "cli",
    });
    sourceCurrent = false;
    entry.controller.abort();
    creation.resolve(taskReceipt(task, settleUnstarted));
    await completion;

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mocks.bindTaskRunOwner).not.toHaveBeenCalled();
    expect(settleUnstarted).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ status: "cancelled" }),
      expect.any(Function),
    );
    expect(task.status).toBe("cancelled");
    expect(emitFinal).toHaveBeenCalledExactlyOnceWith(
      [
        true,
        expect.objectContaining({
          runId,
          status: "timeout",
          summary: "aborted",
          stopReason: "rpc",
        }),
        undefined,
      ],
      { runId },
    );
  });

  it.each(["current", "different-session", "adopted-task"] as const)(
    "waits for task creation before activation and respects owner replacement (%s)",
    async (replacement) => {
      const { runId, sessionKey, context, entry, task } = createTrackedDispatch();
      const creation = createDeferred<CreatedDetachedTaskRun>();
      const settleUnstarted = vi.fn<CreatedDetachedTaskRun["settleUnstarted"]>(
        async (terminal, canSettle) => {
          if (!canSettle(task)) {
            return false;
          }
          Object.assign(task, terminal);
          return true;
        },
      );
      const receipt = taskReceipt(task, settleUnstarted);
      mocks.createRunningTaskRun.mockReturnValue(task);
      mocks.createTaskReceipt.mockImplementation((_params, assertCurrent) => {
        assertCurrent();
        return creation.promise;
      });
      const cleanupAbortController = vi.fn();
      const emitFinal = vi.fn();
      const onSettled = vi.fn(async () => true);
      const completion = dispatchAgentRunFromGateway({
        assertCurrent() {
          if (context.chatAbortControllers.get(runId) !== entry) {
            throw new Error("Gateway run owner replaced");
          }
        },
        ingressOpts: {
          message: task.task,
          sessionKey,
          allowModelOverride: false,
        },
        runId,
        dedupeKeys: [`agent:${runId}`],
        admittedRunEntry: entry,
        abortController: entry.controller,
        cleanupAbortController,
        io: { emitAcceptance: vi.fn(), emitFinal },
        context,
        taskTrackingMode: "cli",
        assertSettlementCurrent() {},
        onSettled,
      });
      try {
        expect(mocks.agentCommand).not.toHaveBeenCalled();
        expect(mocks.bindTaskRunOwner).not.toHaveBeenCalled();
        expect(emitFinal).not.toHaveBeenCalled();
        const successor: ChatAbortControllerEntry = {
          ...entry,
          controller: new AbortController(),
          operationalRunInstance: { runId, instanceId: "replacement-instance" },
          sessionKey:
            replacement === "different-session" ? "agent:main:successor-session" : sessionKey,
        };
        const successorTask: TaskRecord =
          replacement === "adopted-task"
            ? task
            : { ...task, taskId: "successor-task", childSessionKey: successor.sessionKey };
        if (replacement !== "current") {
          context.chatAbortControllers.set(runId, successor);
        }
        // Return the acknowledged task even when its execution owner retired after commit.
        creation.resolve(receipt);
        await completion;

        expect(cleanupAbortController).toHaveBeenCalledOnce();
        expect(onSettled).toHaveBeenCalledOnce();
        expect(emitFinal).toHaveBeenCalledOnce();
        if (replacement !== "current") {
          expect(mocks.agentCommand).not.toHaveBeenCalled();
          expect(mocks.bindTaskRunOwner).not.toHaveBeenCalled();
          expect(mocks.finalizeTrackedTask).not.toHaveBeenCalled();
          expect(mocks.clearAgentRunContext).not.toHaveBeenCalled();
          expect(context.chatAbortControllers.get(runId)).toBe(successor);
          expect(settleUnstarted).toHaveBeenCalledOnce();
          expect(successorTask.status).toBe("running");
          expect(task.status).toBe(replacement === "different-session" ? "failed" : "running");
          expect(emitFinal).toHaveBeenCalledWith(
            [false, expect.objectContaining({ status: "error" }), expect.any(Object)],
            expect.objectContaining({ runId, error: "Gateway run owner replaced" }),
          );
        } else {
          expect(settleUnstarted).not.toHaveBeenCalled();
          expect(mocks.agentCommand).toHaveBeenCalledOnce();
          expect(mocks.bindTaskRunOwner).toHaveBeenCalledOnce();
          expect(mocks.finalizeActive).toHaveBeenCalledWith(
            task,
            expect.objectContaining({ status: "succeeded" }),
            expect.any(Function),
          );
          expect(emitFinal).toHaveBeenCalledWith(
            [true, expect.objectContaining({ status: "ok" }), undefined],
            { runId },
          );
        }
      } finally {
        creation.resolve(receipt);
        await completion;
      }
    },
  );

  it.each([
    { phase: "admission", replacement: "none", failed: true },
    { phase: "execution", replacement: "different-session", failed: false },
    { phase: "execution", replacement: "different-session", failed: true },
    { phase: "execution", replacement: "same-session", failed: false },
    { phase: "execution", replacement: "task-owner", failed: false },
  ] as const)(
    "settles $phase after $replacement replacement (failed=$failed)",
    async ({ phase, replacement, failed }) => {
      const { runId, sessionKey, context, entry, task } = createTrackedDispatch();
      const settleUnstarted = vi.fn<CreatedDetachedTaskRun["settleUnstarted"]>(
        async (terminal, canSettle) => {
          if (!canSettle(task)) {
            return false;
          }
          Object.assign(task, terminal);
          return true;
        },
      );
      mocks.createTaskReceipt.mockResolvedValue(taskReceipt(task, settleUnstarted));
      const adoptedOwner: TaskRunOwner = { task, cancel: vi.fn<TaskRunOwner["cancel"]>() };
      const successor: ChatAbortControllerEntry = {
        ...entry,
        controller: new AbortController(),
        operationalRunInstance: { runId, instanceId: "replacement-instance" },
        sessionKey:
          replacement === "different-session" ? "agent:main:successor-session" : sessionKey,
      };
      mocks.agentCommand.mockImplementationOnce(async (options) => {
        if (phase === "execution") {
          await options.onExecutionStarted?.();
        }
        if (replacement === "different-session" || replacement === "same-session") {
          context.chatAbortControllers.set(runId, successor);
        }
        if (replacement === "task-owner") {
          mocks.taskRunOwners.set(task.taskId, adoptedOwner);
        }
        if (failed) {
          throw new Error("Agent startup or execution failed");
        }
        return { payloads: [], meta: {} };
      });
      const cleanupAbortController = vi.fn();
      const emitFinal = vi.fn();
      await dispatchAgentRunFromGateway({
        ingressOpts: { message: task.task, sessionKey, allowModelOverride: false },
        runId,
        dedupeKeys: [`agent:${runId}`],
        admittedRunEntry: entry,
        abortController: entry.controller,
        cleanupAbortController,
        io: { emitAcceptance: vi.fn(), emitFinal },
        context,
        taskTrackingMode: "cli",
        assertSettlementCurrent() {},
      });

      expect(mocks.agentCommand).toHaveBeenCalledOnce();
      expect(cleanupAbortController).toHaveBeenCalledOnce();
      expect(emitFinal).toHaveBeenCalledOnce();
      if (phase === "admission") {
        expect(settleUnstarted).toHaveBeenCalledOnce();
        expect(task.status).toBe("failed");
        expect(mocks.finalizeTrackedTask).not.toHaveBeenCalled();
      } else {
        expect(settleUnstarted).not.toHaveBeenCalled();
        if (replacement === "different-session") {
          expect(mocks.finalizeActive).toHaveBeenCalledWith(
            task,
            expect.objectContaining({ status: failed ? "failed" : "succeeded" }),
            expect.any(Function),
          );
          expect(context.chatAbortControllers.get(runId)).toBe(successor);
          expect(mocks.clearAgentRunContext).not.toHaveBeenCalled();
        } else {
          expect(mocks.finalizeTrackedTask).not.toHaveBeenCalled();
          expect(task.status).toBe("running");
          if (replacement === "task-owner") {
            expect(mocks.taskRunOwners.get(task.taskId)).toBe(adoptedOwner);
          }
        }
      }
    },
  );

  it.each([
    { outcome: "success", replacement: "none", cleanupFails: false },
    { outcome: "abort", replacement: "none", cleanupFails: false },
    { outcome: "timeout", replacement: "none", cleanupFails: false },
    { outcome: "timeout", replacement: "same-session", cleanupFails: false },
    { outcome: "abort", replacement: "task-owner", cleanupFails: false },
    { outcome: "success", replacement: "different-session", cleanupFails: false },
    { outcome: "abort", replacement: "none", cleanupFails: true },
  ] as const)(
    "uses exact receipt for resolved $outcome before execution ($replacement, cleanupFails=$cleanupFails)",
    async ({ outcome, replacement, cleanupFails }) => {
      const { runId, sessionKey, context, entry, task } = createTrackedDispatch();
      const sibling = { ...task, taskId: "run-sibling" };
      const successor: ChatAbortControllerEntry = {
        ...entry,
        controller: new AbortController(),
        operationalRunInstance: { runId, instanceId: "replacement-instance" },
        sessionKey: replacement === "different-session" ? "agent:main:replacement" : sessionKey,
      };
      const adoptedOwner: TaskRunOwner = { task, cancel: vi.fn<TaskRunOwner["cancel"]>() };
      const entered = createDeferred();
      const resume = createDeferred();
      const settleUnstarted = vi.fn<CreatedDetachedTaskRun["settleUnstarted"]>(
        async (terminal, canSettle) => {
          entered.resolve();
          await resume.promise;
          if (cleanupFails) {
            throw new Error("Receipt settlement failed");
          }
          if (!canSettle(task)) {
            return false;
          }
          Object.assign(task, terminal);
          return true;
        },
      );
      mocks.createTaskReceipt.mockResolvedValue(taskReceipt(task, settleUnstarted));
      // A run-scoped finalizer would also write this unrelated matching sibling.
      mocks.finalizeTrackedTask.mockImplementation((terminal: { status: TaskRecord["status"] }) => {
        task.status = terminal.status;
        sibling.status = terminal.status;
      });
      mocks.agentCommand.mockImplementationOnce(async () => {
        if (replacement === "same-session" || replacement === "different-session") {
          context.chatAbortControllers.set(runId, successor);
        } else if (replacement === "task-owner") {
          mocks.taskRunOwners.set(task.taskId, adoptedOwner);
        }
        return {
          payloads: [],
          meta:
            outcome === "abort"
              ? { aborted: true, stopReason: "rpc" }
              : outcome === "timeout"
                ? { stopReason: "timeout", timeoutPhase: "preflight", providerStarted: false }
                : {},
        };
      });
      const emitFinal = vi.fn();
      const onSettled = vi.fn(() => true);
      const completion = dispatchAgentRunFromGateway({
        ingressOpts: { message: task.task, sessionKey, allowModelOverride: false },
        runId,
        dedupeKeys: [],
        admittedRunEntry: entry,
        abortController: entry.controller,
        cleanupAbortController: vi.fn(),
        io: { emitAcceptance: vi.fn(), emitFinal },
        context,
        taskTrackingMode: "cli",
        assertSettlementCurrent() {},
        onSettled,
      });
      try {
        await Promise.race([entered.promise, completion]);
        expect(settleUnstarted).toHaveBeenCalledOnce();
        expect(mocks.finalizeTrackedTask).not.toHaveBeenCalled();
        expect(onSettled).not.toHaveBeenCalled();
        expect(emitFinal).not.toHaveBeenCalled();
        resume.resolve();
        await completion;
        const expectedStatus =
          outcome === "success" ? "succeeded" : outcome === "abort" ? "cancelled" : "timed_out";
        expect(task.status).toBe(
          cleanupFails || replacement === "same-session" || replacement === "task-owner"
            ? "running"
            : expectedStatus,
        );
        expect(sibling.status).toBe("running");
        expect(settleUnstarted).toHaveBeenCalledWith(
          expect.objectContaining({ status: expectedStatus }),
          expect.any(Function),
        );
        expect(mocks.finalizeTrackedTask).not.toHaveBeenCalled();
        expect(onSettled).toHaveBeenCalledOnce();
        expect(emitFinal).toHaveBeenCalledOnce();
        expect(emitFinal).toHaveBeenCalledWith(
          [
            true,
            expect.objectContaining({
              status: outcome === "success" ? "ok" : "timeout",
              summary: outcome === "success" ? "completed" : "aborted",
              ...(outcome === "timeout"
                ? { timeoutPhase: "preflight", providerStarted: false }
                : {}),
            }),
            undefined,
          ],
          { runId },
        );
        if (replacement === "same-session" || replacement === "different-session") {
          expect(context.chatAbortControllers.get(runId)).toBe(successor);
          expect(mocks.clearAgentRunContext).not.toHaveBeenCalled();
        }
        if (replacement === "task-owner") {
          expect(mocks.taskRunOwners.get(task.taskId)).toBe(adoptedOwner);
        }
        if (cleanupFails) {
          expect(context.logGateway.warn).toHaveBeenCalledWith(
            expect.stringContaining("failed to settle unstarted tracked task"),
          );
        }
      } finally {
        resume.resolve();
        await completion;
      }
    },
  );
});
