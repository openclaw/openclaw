/**
 * Tests for task gateway methods and persisted task lifecycle responses.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTaskRecord as createTaskRecordOrNull,
  markTaskTerminalById,
  recordTaskProgressByRunId,
  resetTaskRegistryForTests,
} from "../../tasks/runtime-internal.js";
import { resetTaskFlowRegistryForTests } from "../../tasks/task-flow-runtime-internal.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import { tasksHandlers } from "./tasks.js";
import type { RespondFn } from "./types.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;
type TaskResponsePayload = {
  tasks?: Array<Record<string, unknown>>;
  task?: Record<string, unknown>;
  found?: boolean;
  cancelled?: boolean;
};

let stateDir: string;

function createTaskRecord(params: Parameters<typeof createTaskRecordOrNull>[0]): TaskRecord {
  const task = createTaskRecordOrNull(params);
  if (!task) {
    throw new Error("expected task creation to succeed");
  }
  return task;
}

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-tasks-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  resetTaskFlowRegistryForTests();
  resetTaskRegistryForTests();
});

afterEach(async () => {
  resetTaskRegistryForTests();
  resetTaskFlowRegistryForTests();
  if (ORIGINAL_STATE_DIR === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
  }
  await fs.rm(stateDir, { recursive: true, force: true });
});

function captureRespond() {
  const calls: Parameters<RespondFn>[] = [];
  const respond: RespondFn = (...args) => {
    calls.push(args);
  };
  return { calls, respond };
}

function createContext() {
  return {
    getRuntimeConfig: () => ({}),
  } as never;
}

async function runTaskHandler(
  method: "tasks.list" | "tasks.get" | "tasks.cancel",
  params: Record<string, unknown>,
) {
  const { calls, respond } = captureRespond();
  await tasksHandlers[method]({
    req: { type: "req", id: `req-${method}`, method },
    params,
    respond,
    context: createContext(),
    client: null,
    isWebchatConnect: () => false,
  });
  return {
    calls,
    payload: calls[0]?.[1] as TaskResponsePayload | undefined,
  };
}

async function getTaskPayload(taskId: string) {
  const { calls, payload } = await runTaskHandler("tasks.get", { taskId });
  expect(calls[0]?.[0]).toBe(true);
  expect(payload?.task?.id).toBe(taskId);
  return { calls, payload };
}

describe("tasks gateway handlers", () => {
  it("creates, lists, gets, and cancels chat task flows", async () => {
    const create = captureRespond();
    await tasksHandlers["taskFlows.create"]({
      req: { type: "req", id: "req-flow-create", method: "taskFlows.create" },
      params: { sessionKey: "main", goal: "Build a proof", currentStep: "Start" },
      respond: create.respond,
      context: createContext(),
      client: null,
      isWebchatConnect: () => false,
    });

    expect(create.calls[0]?.[0]).toBe(true);
    const createPayload = create.calls[0]?.[1] as
      | { flow?: { id?: string; status?: string } }
      | undefined;
    const flow = createPayload?.flow;
    expect(flow).toMatchObject({
      id: expect.any(String),
      status: "running",
    });
    const flowId = flow?.id;
    expect(flowId).toEqual(expect.any(String));
    if (!flowId) {
      throw new Error("Expected taskFlows.create to return a flow id");
    }

    const list = captureRespond();
    await tasksHandlers["taskFlows.list"]({
      req: { type: "req", id: "req-flow-list", method: "taskFlows.list" },
      params: { sessionKey: "main" },
      respond: list.respond,
      context: createContext(),
      client: null,
      isWebchatConnect: () => false,
    });

    expect(list.calls[0]?.[0]).toBe(true);
    expect(list.calls[0]?.[1]).toMatchObject({
      flows: [{ id: flowId, goal: "Build a proof", status: "running" }],
    });

    const get = captureRespond();
    await tasksHandlers["taskFlows.get"]({
      req: { type: "req", id: "req-flow-get", method: "taskFlows.get" },
      params: { flowId, sessionKey: "main" },
      respond: get.respond,
      context: createContext(),
      client: null,
      isWebchatConnect: () => false,
    });

    expect(get.calls[0]?.[0]).toBe(true);
    expect(get.calls[0]?.[1]).toMatchObject({
      flow: {
        id: flowId,
        taskSummary: { total: 0, active: 0, terminal: 0, failures: 0 },
        tasks: [],
      },
    });

    const cancel = captureRespond();
    await tasksHandlers["taskFlows.cancel"]({
      req: { type: "req", id: "req-flow-cancel", method: "taskFlows.cancel" },
      params: { flowId, sessionKey: "main" },
      respond: cancel.respond,
      context: createContext(),
      client: null,
      isWebchatConnect: () => false,
    });

    expect(cancel.calls[0]?.[0]).toBe(true);
    expect(cancel.calls[0]?.[1]).toMatchObject({
      found: true,
      cancelled: true,
      flow: { id: flowId, status: "cancelled" },
    });
  });

  it("keeps task flow lookups scoped to the requested chat session", async () => {
    const create = captureRespond();
    await tasksHandlers["taskFlows.create"]({
      req: { type: "req", id: "req-flow-create-other", method: "taskFlows.create" },
      params: { sessionKey: "main", goal: "Private goal" },
      respond: create.respond,
      context: createContext(),
      client: null,
      isWebchatConnect: () => false,
    });
    const createPayload = create.calls[0]?.[1] as { flow?: { id?: string } } | undefined;
    const flowId = createPayload?.flow?.id;
    expect(flowId).toEqual(expect.any(String));
    if (!flowId) {
      throw new Error("Expected taskFlows.create to return a flow id");
    }

    const get = captureRespond();
    await tasksHandlers["taskFlows.get"]({
      req: { type: "req", id: "req-flow-get-other", method: "taskFlows.get" },
      params: { flowId, sessionKey: "other" },
      respond: get.respond,
      context: createContext(),
      client: null,
      isWebchatConnect: () => false,
    });

    expect(get.calls[0]?.[0]).toBe(false);
  });

  it("lists task summaries with SDK-facing statuses and filters", async () => {
    const running = createTaskRecord({
      runtime: "subagent",
      taskKind: "investigation",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:worker:subagent:child",
      agentId: "main",
      runId: "run-running",
      task: "Investigate issue",
      status: "running",
      deliveryStatus: "pending",
    });
    createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:other:main",
      ownerKey: "agent:other:main",
      scopeKind: "session",
      runId: "run-other",
      task: "Other task",
      status: "running",
      deliveryStatus: "pending",
    });

    const { calls, payload } = await runTaskHandler("tasks.list", {
      status: "running",
      agentId: "main",
      sessionKey: "agent:main:main",
    });

    expect(calls[0]?.[0]).toBe(true);
    expect(payload?.tasks).toHaveLength(1);
    const listedTask = payload?.tasks?.[0];
    expect(listedTask?.id).toBe(running.taskId);
    expect(listedTask?.taskId).toBe(running.taskId);
    expect(listedTask?.kind).toBe("investigation");
    expect(listedTask?.runtime).toBe("subagent");
    expect(listedTask?.status).toBe("running");
    expect(listedTask?.title).toBe("Investigate issue");
    expect(listedTask?.agentId).toBe("main");
    expect(listedTask?.sessionKey).toBe("agent:main:main");
    expect(listedTask?.childSessionKey).toBe("agent:worker:subagent:child");
    expect(listedTask?.runId).toBe("run-running");
  });

  it("treats explicit task agentId as authoritative over the session-key fallback", async () => {
    // Cross-agent subagent task: the registry derives agentId=worker from the
    // child session key, while owner/requester keys belong to main. tasks.list
    // for main must not leak the worker task through the session-key fallback.
    const workerTask = createTaskRecord({
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:worker:subagent:child",
      runId: "run-worker-authoritative",
      task: "Inspect worker state",
      status: "running",
      deliveryStatus: "pending",
    });
    expect(workerTask.agentId).toBe("worker");

    const mainView = await runTaskHandler("tasks.list", { agentId: "main" });
    expect(mainView.calls[0]?.[0]).toBe(true);
    expect(mainView.payload?.tasks ?? []).toEqual([]);

    const workerView = await runTaskHandler("tasks.list", { agentId: "worker" });
    expect(workerView.payload?.tasks?.map((task) => task.taskId)).toEqual([workerTask.taskId]);
  });

  it("gets completed tasks with stable completed status", async () => {
    const task = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      runId: "run-completed",
      task: "Done task",
      status: "succeeded",
      deliveryStatus: "not_applicable",
    });

    const { payload } = await getTaskPayload(task.taskId);

    expect(payload?.task?.status).toBe("completed");
    expect(payload?.task?.title).toBe("Done task");
  });

  it("sanitizes task text before exposing SDK summaries", async () => {
    const task = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      runId: "run-sanitized",
      label:
        "Compile artifact\nOpenClaw runtime context (internal): Keep internal details private.",
      task: "Compile artifact",
      status: "running",
      deliveryStatus: "pending",
    });
    recordTaskProgressByRunId({
      runId: "run-sanitized",
      progressSummary:
        "Bundling output\nOpenClaw runtime context (internal): Keep internal details private.",
    });
    markTaskTerminalById({
      taskId: task.taskId,
      status: "failed",
      endedAt: Date.now(),
      terminalSummary:
        "Failed after build\nOpenClaw runtime context (internal): Keep internal details private.",
      error: "Tool failed\nOpenClaw runtime context (internal): Keep internal details private.",
    });

    const { calls, payload } = await getTaskPayload(task.taskId);

    expect(payload?.task?.title).toBe("Compile artifact");
    expect(payload?.task?.terminalSummary).toBe("Failed after build");
    expect(payload?.task?.error).toBe("Tool failed");
    expect(JSON.stringify(calls[0]?.[1])).not.toContain("OpenClaw runtime context");
  });

  it("cancels running task records and returns the updated task", async () => {
    const task = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      runId: "run-cancel",
      task: "Cancelable task",
      status: "running",
      deliveryStatus: "pending",
    });

    const { calls, payload } = await runTaskHandler("tasks.cancel", {
      taskId: task.taskId,
      reason: "user stopped task",
    });

    expect(calls[0]?.[0]).toBe(true);
    expect(payload?.found).toBe(true);
    expect(payload?.cancelled).toBe(true);
    expect(payload?.task?.id).toBe(task.taskId);
    expect(payload?.task?.status).toBe("cancelled");
    expect(payload?.task?.error).toBe("user stopped task");
  });
});
