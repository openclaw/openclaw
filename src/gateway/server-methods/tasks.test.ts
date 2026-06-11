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
import { tasksHandlers } from "./tasks.js";
import type { RespondFn } from "./types.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

let stateDir: string;

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-tasks-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  resetTaskRegistryForTests();
});

afterEach(async () => {
  resetTaskRegistryForTests();
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
    expect(calls[0]?.[1]).toMatchObject({
      tasks: [
        {
          id: running.taskId,
          taskId: running.taskId,
          kind: "investigation",
          runtime: "subagent",
          status: "running",
          title: "Investigate issue",
          agentId: "main",
          sessionKey: "agent:main:main",
          childSessionKey: "agent:worker:subagent:child",
          runId: "run-running",
        },
      ],
    });
  });

  it("filters tasks by runId", async () => {
    const wanted = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      runId: "run-wanted",
      task: "Wanted task",
      status: "running",
      deliveryStatus: "pending",
    });
    createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      runId: "run-other",
      task: "Other task",
      status: "running",
      deliveryStatus: "pending",
    });

    const { calls, respond } = captureRespond();
    await tasksHandlers["tasks.list"]({
      req: { type: "req", id: "req-run-filter", method: "tasks.list" },
      params: { runId: "run-wanted", sessionKey: "agent:main:main" },
      respond,
      context: createContext(),
      client: null,
      isWebchatConnect: () => false,
    });

    expect(calls[0]?.[0]).toBe(true);
    expect(calls[0]?.[1]).toMatchObject({
      tasks: [{ id: wanted.taskId, runId: "run-wanted", title: "Wanted task" }],
    });
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
    expect(calls[0]?.[1]).toMatchObject({
      task: {
        id: task.taskId,
        status: "completed",
        title: "Done task",
      },
    });
  });

  it("exposes judge-blocked task completions with blocked status and evidence", async () => {
    const task = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      runId: "run-blocked",
      task: "Create a video game",
      status: "succeeded",
      deliveryStatus: "pending",
      terminalOutcome: "blocked",
      userVisible: true,
      expectedDeliverable: "requested artifact",
      acceptanceCriteria: ["attach the requested artifact"],
      artifactIds: ["artifact-game-1"],
      judgeStatus: "rejected",
      judgeVerdict: "REQUEST_MORE_EVIDENCE",
      judgeReason: "Missing playable artifact.",
      judgeRunId: "judge-run-blocked",
      blockedReason: "Judge blocked completion.",
    });

    const get = captureRespond();
    await tasksHandlers["tasks.get"]({
      req: { type: "req", id: "req-blocked-get", method: "tasks.get" },
      params: { taskId: task.taskId },
      respond: get.respond,
      context: createContext(),
      client: null,
      isWebchatConnect: () => false,
    });

    expect(get.calls[0]?.[0]).toBe(true);
    expect(get.calls[0]?.[1]).toMatchObject({
      task: {
        id: task.taskId,
        status: "blocked",
        userVisible: true,
        expectedDeliverable: "requested artifact",
        acceptanceCriteria: ["attach the requested artifact"],
        artifactIds: ["artifact-game-1"],
        judgeStatus: "rejected",
        judgeVerdict: "REQUEST_MORE_EVIDENCE",
        judgeReason: "Missing playable artifact.",
        judgeRunId: "judge-run-blocked",
        blockedReason: "Judge blocked completion.",
      },
    });

    const list = captureRespond();
    await tasksHandlers["tasks.list"]({
      req: { type: "req", id: "req-blocked-list", method: "tasks.list" },
      params: { status: "blocked" },
      respond: list.respond,
      context: createContext(),
      client: null,
      isWebchatConnect: () => false,
    });

    expect(list.calls[0]?.[0]).toBe(true);
    expect(list.calls[0]?.[1]).toMatchObject({
      tasks: [{ id: task.taskId, status: "blocked" }],
    });
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
    expect(calls[0]?.[1]).toMatchObject({
      task: {
        id: task.taskId,
        title: "Compile artifact",
        terminalSummary: "Failed after build",
        error: "Tool failed",
      },
    });
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
    expect(calls[0]?.[1]).toMatchObject({
      found: true,
      cancelled: true,
      task: {
        id: task.taskId,
        status: "cancelled",
        error: "user stopped task",
      },
    });
  });
});
