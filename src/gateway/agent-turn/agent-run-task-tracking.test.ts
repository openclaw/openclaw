import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  withFollowupRequest,
  withFollowupSuccessor,
} from "../../agents/subagents/completion/session-followup-completion.js";
import type { FollowupRequest } from "../../agents/subagents/completion/session-followup-completion.types.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import type { CreatedDetachedTaskRun } from "../../tasks/detached-task-runtime-contract.js";
import type { PreparedDetachedTaskRun } from "../../tasks/detached-task-runtime.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import type { TaskRunOwner } from "../../tasks/task-run-owner.types.js";
import { bindInProcessSubagentResume } from "../in-process-subagent-resume.js";
import {
  prepareAgentRunTaskTracking,
  registerSessionFollowupTask,
  settleUnstartedGatewayAgentTask,
} from "./agent-run-task-tracking.js";
import type { AgentTurnPrincipal } from "./types.js";

const mocks = vi.hoisted(() => ({
  findTaskViewByRunIdAsync:
    vi.fn<(runId: string, assertCurrent: () => void) => Promise<TaskRecord | undefined>>(),
  findTaskByRunId: vi.fn(),
  registerSubagentRun: vi.fn(),
  adoptPausedSubagentRunForFollowUp: vi.fn(),
  prepareParentSubagentResume: vi.fn(),
  prepareRunningTaskRun: vi.fn<() => PreparedDetachedTaskRun>(),
  getRegisteredDetachedTaskLifecycleRuntime: vi.fn(),
  owners: new Map<string, TaskRunOwner>(),
}));

vi.mock("../../tasks/runtime-internal.js", () => ({
  findTaskViewByRunIdAsync: mocks.findTaskViewByRunIdAsync,
  findTaskByRunId: mocks.findTaskByRunId,
}));
vi.mock("../../tasks/detached-task-runtime.js", () => ({
  finalizeTaskRunByRunId: vi.fn(),
  prepareRunningTaskRun: mocks.prepareRunningTaskRun,
}));
vi.mock("../../tasks/detached-task-runtime-state.js", () => ({
  getRegisteredDetachedTaskLifecycleRuntime: mocks.getRegisteredDetachedTaskLifecycleRuntime,
}));
vi.mock("../../tasks/task-run-owner.js", () => ({
  getTaskRunOwner: (task: TaskRecord) => mocks.owners.get(task.taskId),
}));
vi.mock("../../acp/runtime/session-meta.js", () => ({ readAcpSessionMeta: vi.fn() }));
vi.mock("../../agents/subagents/registry/subagent-registry-read.js", () => ({
  getLatestLiveSubagentRunByChildSessionKey: vi.fn(),
}));
vi.mock("../../agents/subagents/registry/subagent-registry.js", () => ({
  registerSubagentRun: mocks.registerSubagentRun,
  adoptPausedSubagentRunForFollowUp: mocks.adoptPausedSubagentRunForFollowUp,
}));
vi.mock("../../config/sessions.js", () => ({
  resolveAgentIdFromSessionKey: () => "main",
  resolveAgentMainSessionKey: () => "agent:main:main",
}));
vi.mock("../session-subagent-resume.js", () => ({
  prepareParentSubagentResume: mocks.prepareParentSubagentResume,
}));
vi.mock("../ws-log.js", () => ({ formatForLog: (value: unknown) => String(value) }));

const childSessionKey = "agent:main:subagent:lookup-child";
const runId = "lookup-run";
const canonicalTask: TaskRecord = {
  taskId: "canonical-task",
  runtime: "subagent",
  requesterSessionKey: "agent:main:main",
  ownerKey: "agent:main:main",
  scopeKind: "session",
  childSessionKey,
  runId,
  task: "Continue the child task",
  status: "running",
  deliveryStatus: "pending",
  notifyPolicy: "done_only",
  createdAt: 1,
};

function pluginClient(): AgentTurnPrincipal {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "gateway-client", version: "test", platform: "test", mode: "backend" },
    },
    internal: { agentRunTracking: "plugin_subagent", pluginRuntimeOwnerId: "example" },
  };
}

function parameters(
  overrides: Partial<Parameters<typeof prepareAgentRunTaskTracking>[0]> = {},
): Parameters<typeof prepareAgentRunTaskTracking>[0] {
  const logGateway: SubsystemLogger = {
    subsystem: "test",
    isEnabled: () => false,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: () => logGateway,
  };
  return {
    cfg: {},
    client: null,
    resolvedSessionKey: childSessionKey,
    canUseInternalRuntimeHandoff: false,
    request: { message: "Continue the child task" },
    isOneShotModelRun: false,
    runId,
    getAdmittedSessionId: () => "child-session",
    assertResumeAdmissionCurrent: vi.fn(),
    context: { logGateway },
    ...overrides,
  };
}

function delayLookup() {
  const lookup = createDeferred<TaskRecord | undefined>();
  mocks.findTaskViewByRunIdAsync.mockImplementation(async (_runId, assertCurrent) => {
    assertCurrent();
    const task = await lookup.promise;
    assertCurrent();
    return task;
  });
  return lookup;
}

describe("prepareAgentRunTaskTracking", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.owners.clear();
    mocks.findTaskViewByRunIdAsync.mockResolvedValue(undefined);
    mocks.adoptPausedSubagentRunForFollowUp.mockReturnValue(false);
  });

  it.each([
    { name: "canonical child", task: canonicalTask, expected: "none" },
    { name: "untracked run", task: undefined, expected: "cli" },
    {
      name: "another child",
      task: { ...canonicalTask, childSessionKey: "agent:main:subagent:other" },
      expected: "cli",
    },
  ])("waits for the $name lookup before choosing tracking", async ({ task, expected }) => {
    const lookup = delayLookup();
    let completed = false;
    const preparation = prepareAgentRunTaskTracking(parameters()).then((result) => {
      completed = true;
      return result;
    });
    try {
      await Promise.resolve();
      expect(completed).toBe(false);
      expect(mocks.registerSubagentRun).not.toHaveBeenCalled();
      lookup.resolve(task);
      await expect(preparation).resolves.toEqual({ taskTrackingMode: expected });
      expect(mocks.findTaskByRunId).not.toHaveBeenCalled();
    } finally {
      lookup.resolve(task);
      await Promise.allSettled([lookup.promise, preparation]);
    }
  });

  it("registers plugin work only after its lookup settles", async () => {
    const lookup = delayLookup();
    const params = parameters({ client: pluginClient() });
    const preparation = prepareAgentRunTaskTracking(params);
    try {
      await Promise.resolve();
      expect(mocks.registerSubagentRun).not.toHaveBeenCalled();
      lookup.resolve(undefined);
      await expect(preparation).resolves.toEqual({ taskTrackingMode: "plugin_subagent" });
      expect(mocks.registerSubagentRun).toHaveBeenCalledOnce();
      expect(mocks.registerSubagentRun).toHaveBeenCalledWith(
        expect.objectContaining({ runId, childSessionKey, task: "Continue the child task" }),
        { assertCurrent: params.assertResumeAdmissionCurrent },
      );
    } finally {
      lookup.resolve(undefined);
      await Promise.allSettled([lookup.promise, preparation]);
    }
  });

  it("rejects lost admission during the lookup before registering plugin work", async () => {
    const lookup = delayLookup();
    let admitted = true;
    const preparation = prepareAgentRunTaskTracking(
      parameters({
        client: pluginClient(),
        assertResumeAdmissionCurrent: () => {
          if (!admitted) {
            throw new Error("admission retired");
          }
        },
      }),
    );
    try {
      const rejected = expect(preparation).rejects.toThrow("admission retired");
      admitted = false;
      lookup.resolve(undefined);
      await rejected;
      expect(mocks.registerSubagentRun).not.toHaveBeenCalled();
      expect(mocks.adoptPausedSubagentRunForFollowUp).not.toHaveBeenCalled();
    } finally {
      lookup.resolve(undefined);
      await Promise.allSettled([lookup.promise, preparation]);
    }
  });

  it("rechecks admission after a successful lookup that does not enforce the caller guard", async () => {
    let admitted = true;
    mocks.findTaskViewByRunIdAsync.mockImplementation(async () => {
      admitted = false;
      return undefined;
    });
    await expect(
      prepareAgentRunTaskTracking(
        parameters({
          client: pluginClient(),
          assertResumeAdmissionCurrent: () => {
            if (!admitted) {
              throw new Error("admission retired");
            }
          },
        }),
      ),
    ).rejects.toThrow("admission retired");
    expect(mocks.registerSubagentRun).not.toHaveBeenCalled();
    expect(mocks.adoptPausedSubagentRunForFollowUp).not.toHaveBeenCalled();
  });

  it("propagates a failed lookup without registering plugin work", async () => {
    const lookup = delayLookup();
    const failure = new Error("task lookup unavailable");
    const preparation = prepareAgentRunTaskTracking(parameters({ client: pluginClient() }));
    try {
      const rejected = expect(preparation).rejects.toBe(failure);
      lookup.reject(failure);
      await rejected;
      expect(mocks.registerSubagentRun).not.toHaveBeenCalled();
    } finally {
      lookup.resolve(undefined);
      await Promise.allSettled([lookup.promise, preparation]);
    }
  });

  it.each([
    { name: "one-shot model", overrides: { isOneShotModelRun: true }, expected: "none" },
    { name: "missing session", overrides: { resolvedSessionKey: undefined }, expected: "none" },
    { name: "blank session", overrides: { resolvedSessionKey: "  " }, expected: "none" },
    { name: "empty run", overrides: { runId: "" }, expected: "cli" },
    { name: "blank run", overrides: { runId: "  " }, expected: "cli" },
  ])("does not query tasks for a $name", async ({ overrides, expected }) => {
    await expect(prepareAgentRunTaskTracking(parameters(overrides))).resolves.toEqual({
      taskTrackingMode: expected,
    });
    expect(mocks.findTaskViewByRunIdAsync).not.toHaveBeenCalled();
    expect(mocks.findTaskByRunId).not.toHaveBeenCalled();
    expect(mocks.registerSubagentRun).not.toHaveBeenCalled();
  });

  it("prepares an explicit parent resume without looking up or registering another task", async () => {
    const client = pluginClient();
    const resume = {
      caller: { agentId: "main", sessionKey: "agent:main:main" },
      childSessionKey,
      childSessionId: "child-session",
      previousRunId: "previous-run",
      taskRunId: "canonical-task",
      generation: 1,
      createdAt: 1,
    };
    client.internal = bindInProcessSubagentResume({}, resume);
    const adoptParentResume = vi.fn(() => "previous-run");
    mocks.prepareParentSubagentResume.mockResolvedValue(adoptParentResume);
    await expect(prepareAgentRunTaskTracking(parameters({ client }))).resolves.toEqual({
      taskTrackingMode: "none",
      adoptParentResume,
    });
    expect(mocks.prepareParentSubagentResume).toHaveBeenCalledWith(
      expect.objectContaining({ resume, runId, sessionKey: childSessionKey }),
    );
    expect(adoptParentResume).not.toHaveBeenCalled();
    expect(mocks.findTaskViewByRunIdAsync).not.toHaveBeenCalled();
    expect(mocks.findTaskByRunId).not.toHaveBeenCalled();
    expect(mocks.registerSubagentRun).not.toHaveBeenCalled();
  });
});

function followupFixture() {
  const task = { ...canonicalTask, runtime: "cli" as const };
  const controller = new AbortController();
  const bindingGate = createDeferred();
  const bindingStarted = createDeferred();
  const release = vi.fn(() => mocks.owners.delete(task.taskId));
  const request: FollowupRequest = {
    runId,
    requesterSessionKey: "agent:main:main",
    requesterSessionId: "requester-session",
    requesterAgentId: "main",
    targetAgentId: "main",
    targetSessionKey: childSessionKey,
    custody: {
      run: (work) => work(),
      assertCurrent: vi.fn(),
      signal: controller.signal,
      release: vi.fn(),
    },
  };
  const receipt: CreatedDetachedTaskRun = {
    task,
    bindRunOwner: vi.fn(async (cancel, assertCurrent) => {
      bindingStarted.resolve();
      await bindingGate.promise;
      assertCurrent();
      const owner = { task, cancel, assertCurrent: vi.fn(), readCurrent: () => task };
      mocks.owners.set(task.taskId, owner);
      return { owner, release };
    }),
    finalizeActive: vi.fn(async (terminal, canSettle) => {
      if (canSettle(task)) {
        Object.assign(task, terminal);
      }
    }),
    settleUnstarted: vi.fn(async (terminal, canSettle) => {
      if (!canSettle(task)) {
        return false;
      }
      Object.assign(task, terminal);
      return true;
    }),
  };
  const create = vi.fn(async () => receipt);
  mocks.prepareRunningTaskRun.mockReturnValue({ kind: "receipt", create });
  const register = () =>
    registerSessionFollowupTask({
      followup: { kind: "session_followup", requesterSessionKey: request.requesterSessionKey },
      runId,
      sessionKey: childSessionKey,
      task: "followup",
      requesterOrigin: undefined,
      assertCurrent: vi.fn(),
    });
  return {
    request,
    receipt,
    task,
    create,
    bindingGate,
    bindingStarted,
    release,
    register,
    controller,
  };
}

function cohort(): SubagentRunRecord[] {
  return [
    {
      runId: "grandchild-run",
      childSessionKey: "agent:main:subagent:grandchild",
      requesterSessionKey: childSessionKey,
      requesterDisplayKey: childSessionKey,
      task: "grandchild",
      cleanup: "keep",
      createdAt: 1,
      execution: { status: "terminal" },
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
        rearmGeneration: 1,
        requesterYieldBatch: true,
      },
    },
  ];
}

describe("Gateway followup completion custody", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.owners.clear();
    mocks.findTaskViewByRunIdAsync.mockResolvedValue(undefined);
  });

  it("does not return registration until the original receipt owner is bound", async () => {
    const f = followupFixture();
    let accepted = false;
    const pending = withFollowupRequest(f.request, f.register).then((tracking) => {
      accepted = true;
      expect(f.request.completion).toBeDefined();
      f.request.completion?.assertCurrent();
      return tracking;
    });
    await f.bindingStarted.promise;
    expect(accepted).toBe(false);
    expect(f.request.completion).toBeUndefined();
    f.bindingGate.resolve();
    try {
      const tracking = await pending;
      expect(tracking).toMatchObject({ kind: "receipt", completion: f.request.completion });
      expect(f.create).toHaveBeenCalledOnce();
      expect(f.receipt.bindRunOwner).toHaveBeenCalledOnce();
    } finally {
      f.request.completion?.close();
    }
  });

  it.each(["run", "target"])(
    "does not attach an unrelated pending %s request",
    async (mismatch) => {
      const f = followupFixture();
      if (mismatch === "run") {
        f.request.runId = "different";
      } else {
        f.request.targetSessionKey = "different";
      }
      const tracking = await withFollowupRequest(f.request, f.register);
      expect(tracking).toMatchObject({ kind: "receipt" });
      expect(f.receipt.bindRunOwner).not.toHaveBeenCalled();
      expect(f.request.completion).toBeUndefined();
    },
  );

  it("preserves registered runtime admission when no core completion request was prepared", async () => {
    const f = followupFixture();
    const finalizeRun = vi.fn(() => [f.task]);
    mocks.getRegisteredDetachedTaskLifecycleRuntime.mockReturnValue({});
    mocks.prepareRunningTaskRun.mockReturnValue({ kind: "legacy", task: f.task, finalizeRun });
    const tracking = await f.register();
    expect(tracking).toMatchObject({ kind: "legacy", task: f.task, finalizeRun });
    expect(mocks.prepareRunningTaskRun).toHaveBeenCalledOnce();
    expect(f.receipt.bindRunOwner).not.toHaveBeenCalled();
    expect(f.request.completion).toBeUndefined();
  });

  it("rejects mismatched requester and a runtime change after core custody preparation", async () => {
    const f = followupFixture();
    f.request.requesterSessionKey = "other-requester";
    await expect(
      withFollowupRequest(f.request, () =>
        registerSessionFollowupTask({
          followup: { kind: "session_followup", requesterSessionKey: "agent:main:main" },
          runId,
          sessionKey: childSessionKey,
          task: "followup",
          requesterOrigin: undefined,
          assertCurrent: vi.fn(),
        }),
      ),
    ).rejects.toThrow("requester");
    expect(mocks.prepareRunningTaskRun).not.toHaveBeenCalled();
    mocks.getRegisteredDetachedTaskLifecycleRuntime.mockReturnValue({});
    await expect(withFollowupRequest(f.request, f.register)).rejects.toThrow("receipt");
    expect(mocks.prepareRunningTaskRun).not.toHaveBeenCalled();
  });

  it("settles the creation receipt if binding fails before acceptance", async () => {
    const f = followupFixture();
    vi.mocked(f.receipt.bindRunOwner).mockRejectedValueOnce(new Error("binding failed"));
    await expect(withFollowupRequest(f.request, f.register)).rejects.toThrow("binding failed");
    expect(f.task.status).toBe("failed");
    expect(f.receipt.settleUnstarted).toHaveBeenCalledOnce();
    expect(f.request.completion).toBeUndefined();
  });

  it.each(["initial", "pending successor", "replacement owner"])(
    "settles only the original unaccepted receipt after revocation (%s)",
    async (kind) => {
      const f = followupFixture();
      f.bindingGate.resolve();
      const tracking = await withFollowupRequest(f.request, f.register);
      if (kind === "pending successor") {
        f.request.completion?.markAccepted(runId);
      }
      f.controller.abort();
      if (kind === "replacement owner") {
        mocks.owners.set(f.task.taskId, { task: f.task, cancel: vi.fn<TaskRunOwner["cancel"]>() });
      }
      await settleUnstartedGatewayAgentTask({
        tracking,
        runId: kind === "pending successor" ? "not-adopted-successor" : runId,
        admittedRunEntry: undefined,
        context: { ...parameters().context, chatAbortControllers: new Map() },
        outcome: { status: "error", reason: "failed", error: "source revoked before acceptance" },
      });
      expect(f.task.status).toBe(kind === "initial" ? "failed" : "running");
      if (kind === "pending successor") {
        expect(f.receipt.settleUnstarted).not.toHaveBeenCalled();
      } else {
        expect(f.receipt.settleUnstarted).toHaveBeenCalledOnce();
      }
    },
  );

  it("prepares the exact successor before ordinary adoption and preserves the predecessor until final admission", async () => {
    const f = followupFixture();
    f.bindingGate.resolve();
    const tracking = await withFollowupRequest(f.request, f.register);
    const owner = f.request.completion!;
    const entries = cohort();
    owner.promoteYield(runId, entries, 1);
    const successor = owner.successor(entries, "successor-run", vi.fn());
    const client = pluginClient();
    client.internal = bindInProcessSubagentResume(client.internal ?? {}, {
      caller: { agentId: "main", sessionKey: "agent:main:main" },
      childSessionKey,
      childSessionId: "child-session",
      previousRunId: "paused-original",
      taskRunId: "original-task",
      generation: 1,
      createdAt: 1,
    });
    let prepared = false;
    const pending = withFollowupSuccessor(successor, () =>
      prepareAgentRunTaskTracking(
        parameters({
          client,
          runId: successor.runId,
        }),
      ),
    ).then((result) => {
      prepared = true;
      return result;
    });
    try {
      await Promise.resolve();
      expect(prepared).toBe(false);
      await owner.settle(runId, { status: "ok", yielded: true });
      owner.finishExecution(runId);
      const result = await pending;
      expect(result).toEqual({ taskTrackingMode: "none", followupSuccessor: successor });
      expect(f.receipt.finalizeActive).not.toHaveBeenCalled();
      expect(mocks.prepareParentSubagentResume).not.toHaveBeenCalled();
      expect(mocks.findTaskViewByRunIdAsync).not.toHaveBeenCalled();
      expect(mocks.registerSubagentRun).not.toHaveBeenCalled();
      expect(f.create).toHaveBeenCalledOnce();
      const context = { ...parameters().context, chatAbortControllers: new Map() };
      const outcome = { status: "error", reason: "failed", error: "admission failed" } as const;
      await settleUnstartedGatewayAgentTask({
        tracking,
        runId: successor.runId,
        admittedRunEntry: undefined,
        context,
        outcome,
      });
      expect(f.task.status).toBe("running");
      owner.adopt(successor);
      expect(f.task.runId).toBe(runId);
      await settleUnstartedGatewayAgentTask({
        tracking,
        runId: successor.runId,
        admittedRunEntry: undefined,
        context,
        outcome,
      });
      expect(f.task.status).toBe("failed");
      await expect(owner.take()).resolves.toMatchObject({
        status: "error",
        error: "admission failed",
      });
    } finally {
      owner.close();
      await pending;
    }
  });
});
