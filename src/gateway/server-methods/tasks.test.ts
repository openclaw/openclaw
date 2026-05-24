import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTaskRecord,
  markTaskTerminalById,
  recordTaskProgressByRunId,
  resetTaskRegistryForTests,
} from "../../tasks/runtime-internal.js";
import {
  createManagedTaskFlow,
  resetTaskFlowRegistryForTests,
} from "../../tasks/task-flow-runtime-internal.js";
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

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-tasks-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  resetTaskRegistryForTests();
  resetTaskFlowRegistryForTests();
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

describe("tasks gateway handlers", () => {
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

    const { calls, respond } = captureRespond();
    await tasksHandlers["tasks.list"]({
      req: { type: "req", id: "req-1", method: "tasks.list" },
      params: {
        status: "running",
        agentId: "main",
        sessionKey: "agent:main:main",
      },
      respond,
      context: createContext(),
      client: null,
      isWebchatConnect: () => false,
    });

    expect(calls[0]?.[0]).toBe(true);
    const payload = calls[0]?.[1] as TaskResponsePayload | undefined;
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

    const { calls, respond } = captureRespond();
    await tasksHandlers["tasks.get"]({
      req: { type: "req", id: "req-2", method: "tasks.get" },
      params: { taskId: task.taskId },
      respond,
      context: createContext(),
      client: null,
      isWebchatConnect: () => false,
    });

    expect(calls[0]?.[0]).toBe(true);
    const payload = calls[0]?.[1] as TaskResponsePayload | undefined;
    expect(payload?.task?.id).toBe(task.taskId);
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

    const { calls, respond } = captureRespond();
    await tasksHandlers["tasks.get"]({
      req: { type: "req", id: "req-sanitized", method: "tasks.get" },
      params: { taskId: task.taskId },
      respond,
      context: createContext(),
      client: null,
      isWebchatConnect: () => false,
    });

    expect(calls[0]?.[0]).toBe(true);
    const payload = calls[0]?.[1] as TaskResponsePayload | undefined;
    expect(payload?.task?.id).toBe(task.taskId);
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

    const { calls, respond } = captureRespond();
    await tasksHandlers["tasks.cancel"]({
      req: { type: "req", id: "req-3", method: "tasks.cancel" },
      params: { taskId: task.taskId, reason: "user stopped task" },
      respond,
      context: createContext(),
      client: null,
      isWebchatConnect: () => false,
    });

    expect(calls[0]?.[0]).toBe(true);
    const payload = calls[0]?.[1] as TaskResponsePayload | undefined;
    expect(payload?.found).toBe(true);
    expect(payload?.cancelled).toBe(true);
    expect(payload?.task?.id).toBe(task.taskId);
    expect(payload?.task?.status).toBe("cancelled");
    expect(payload?.task?.error).toBe("user stopped task");
  });

  it("lists and gets TaskFlows through gateway methods", async () => {
    const flow = createManagedTaskFlow({
      ownerKey: "agent:main:main",
      controllerId: "lobster-builder/test-run",
      status: "waiting",
      goal: "Run Lobster workflow",
      currentStep: "await_lobster_approval",
      waitJson: { kind: "lobster_approval", prompt: "Approve?" },
    });
    createManagedTaskFlow({
      ownerKey: "agent:other:main",
      controllerId: "lobster-builder/test-run",
      status: "waiting",
      goal: "Other Lobster workflow",
    });

    const listCapture = captureRespond();
    await tasksHandlers["tasks.flows.list"]({
      req: { type: "req", id: "req-flows-list", method: "tasks.flows.list" },
      params: {
        status: "waiting",
        sessionKey: "agent:main:main",
      },
      respond: listCapture.respond,
      context: createContext(),
      client: null,
      isWebchatConnect: () => false,
    });

    expect(listCapture.calls[0]?.[0]).toBe(true);
    const listPayload = listCapture.calls[0]?.[1] as { flows?: Array<Record<string, unknown>> };
    expect(listPayload.flows).toHaveLength(1);
    expect(listPayload.flows?.[0]).toMatchObject({
      id: flow.flowId,
      ownerKey: "agent:main:main",
      status: "waiting",
      goal: "Run Lobster workflow",
      currentStep: "await_lobster_approval",
    });

    const getCapture = captureRespond();
    await tasksHandlers["tasks.flows.get"]({
      req: { type: "req", id: "req-flows-get", method: "tasks.flows.get" },
      params: { flowId: flow.flowId },
      respond: getCapture.respond,
      context: createContext(),
      client: null,
      isWebchatConnect: () => false,
    });

    expect(getCapture.calls[0]?.[0]).toBe(true);
    const getPayload = getCapture.calls[0]?.[1] as { flow?: Record<string, unknown> };
    expect(getPayload.flow).toMatchObject({
      id: flow.flowId,
      status: "waiting",
      wait: { kind: "lobster_approval", prompt: "Approve?" },
      taskSummary: { total: 0, active: 0 },
    });
  });

  it("cancels managed TaskFlows", async () => {
    const flow = createManagedTaskFlow({
      ownerKey: "agent:main:main",
      controllerId: "lobster-builder/test-run",
      status: "running",
      goal: "Run Lobster workflow",
      currentStep: "run_lobster",
    });

    const { calls, respond } = captureRespond();
    await tasksHandlers["tasks.flows.cancel"]({
      req: { type: "req", id: "req-flows-cancel", method: "tasks.flows.cancel" },
      params: { flowId: flow.flowId },
      respond,
      context: createContext(),
      client: null,
      isWebchatConnect: () => false,
    });

    expect(calls[0]?.[0]).toBe(true);
    const payload = calls[0]?.[1] as {
      found?: boolean;
      cancelled?: boolean;
      flow?: Record<string, unknown>;
    };
    expect(payload.found).toBe(true);
    expect(payload.cancelled).toBe(true);
    expect(payload.flow).toMatchObject({
      id: flow.flowId,
      status: "cancelled",
    });
  });
});
