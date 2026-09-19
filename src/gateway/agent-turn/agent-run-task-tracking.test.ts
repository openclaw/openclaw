import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import { bindInProcessSubagentResume } from "../in-process-subagent-resume.js";
import { prepareAgentRunTaskTracking } from "./agent-run-task-tracking.js";
import type { AgentTurnPrincipal } from "./types.js";

const mocks = vi.hoisted(() => ({
  findTaskViewByRunIdAsync:
    vi.fn<(runId: string, assertCurrent: () => void) => Promise<TaskRecord | undefined>>(),
  findTaskByRunId: vi.fn(),
  registerSubagentRun: vi.fn(),
  adoptPausedSubagentRunForFollowUp: vi.fn(),
  prepareParentSubagentResume: vi.fn(),
}));

vi.mock("../../tasks/runtime-internal.js", () => ({
  findTaskViewByRunIdAsync: mocks.findTaskViewByRunIdAsync,
  findTaskByRunId: mocks.findTaskByRunId,
}));
vi.mock("../../tasks/detached-task-runtime.js", () => ({
  finalizeTaskRunByRunId: vi.fn(),
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
    const preparation = prepareAgentRunTaskTracking(parameters({ client: pluginClient() }));
    try {
      await Promise.resolve();
      expect(mocks.registerSubagentRun).not.toHaveBeenCalled();
      lookup.resolve(undefined);
      await expect(preparation).resolves.toEqual({ taskTrackingMode: "plugin_subagent" });
      expect(mocks.registerSubagentRun).toHaveBeenCalledOnce();
      expect(mocks.registerSubagentRun).toHaveBeenCalledWith(
        expect.objectContaining({ runId, childSessionKey, task: "Continue the child task" }),
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
