import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  addSession,
  deleteSession,
  markBackgrounded,
  markExited,
} from "../agents/bash-process-registry.js";
import { createProcessSessionFixture } from "../agents/bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "../agents/bash-process-registry.test-support.js";
import * as nativeExecution from "../agents/subagents/registry/subagent-execution-observation.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { registerAgentRunCapacityWait } from "../infra/agent-run-capacity-wait.js";
import {
  claimAgentRunContext,
  getAgentRunLifecycleGeneration,
  releaseAgentRunContext,
  resetAgentRunRegistryForTest,
} from "../infra/agent-run-registry.js";
import { createSubagentTaskBackingDetail } from "./task-backing-records.js";
import { getTaskExecutionObservation } from "./task-execution-observation.js";
import { recordTaskActivityEvent } from "./task-registry-activity.js";
import { clearTaskActivity } from "./task-registry-state.js";
import type { TaskRecord, TaskStatus } from "./task-registry.types.js";

const taskIds = new Set<string>();
const runIds = new Set<string>();

function task(id: string, status: TaskStatus): TaskRecord {
  taskIds.add(id);
  return {
    taskId: id,
    runtime: "subagent",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    childSessionKey: `agent:main:subagent:${id}`,
    runId: id,
    task: "Observe the task",
    status,
    deliveryStatus: "pending",
    notifyPolicy: "silent",
    createdAt: 1,
    detail: createSubagentTaskBackingDetail(1),
  };
}

function registerRun(record: TaskRecord, overrides: Partial<SubagentRunRecord> = {}) {
  const run: SubagentRunRecord = {
    runId: record.taskId,
    childSessionKey: `agent:main:subagent:${record.taskId}`,
    requesterSessionKey: record.requesterSessionKey,
    requesterDisplayKey: "main",
    task: record.task,
    cleanup: "keep",
    createdAt: 1,
    generation: 1,
    execution: { status: "running", startedAt: 1 },
    ...overrides,
  };
  runIds.add(run.runId);
  subagentRuns.set(run.runId, run);
  return run;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  resetAgentRunRegistryForTest();
  for (const id of taskIds) {
    clearTaskActivity(id);
  }
  for (const id of runIds) {
    subagentRuns.delete(id);
  }
  resetProcessRegistryForTests();
  taskIds.clear();
  runIds.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(["agent:main:dashboard:stored", "global"])(
  "resolves stored CLI task ownership without agentId for %s",
  (sessionKey) => {
    const runId = "stored-cli";
    const record: TaskRecord = {
      ...task(runId, "running"),
      runtime: "cli",
      childSessionKey: sessionKey,
      detail: undefined,
    };
    for (const agentId of ["main", "other"]) {
      resetAgentRunRegistryForTest();
      claimAgentRunContext(runId, { sessionKey, agentId }, { trackOwner: true, ownsContext: true });
      expect(getTaskExecutionObservation(record)).toEqual({
        state: agentId === "main" ? "running" : "unknown",
      });
    }
  },
);

it.each([false, true])("reports capacity-waiting subagents as queued (collector=%s)", (collect) => {
  const record = task("capacity-waiting-child", "running");
  const run = registerRun(record, { collect });
  const claim = claimAgentRunContext(
    run.runId,
    { sessionKey: run.childSessionKey },
    { trackOwner: true, ownsContext: true },
  );
  recordTaskActivityEvent(record, {
    runId: run.runId,
    seq: 1,
    stream: "tool",
    ts: 10,
    data: { phase: "start", name: "previous_tool", toolCallId: "previous-tool" },
  });
  const releaseWait = registerAgentRunCapacityWait(run.runId, getAgentRunLifecycleGeneration());
  try {
    // Gateway acceptance and old activity do not establish execution while the queue owns a wait.
    expect(getTaskExecutionObservation(record)).toEqual({ state: "queued", lastActivityAt: 10 });
    expect(record.status).toBe("running");
    releaseWait?.();
    expect(getTaskExecutionObservation(record)).toEqual({
      state: "running",
      lastActivityAt: 10,
      currentTool: { name: "previous_tool", startedAt: 10 },
    });
  } finally {
    releaseWait?.();
    releaseAgentRunContext(run.runId, claim);
  }
  expect(getTaskExecutionObservation(record)).toEqual({ state: "unknown", lastActivityAt: 10 });
});

it("projects terminal task statuses without observing retained native executions", () => {
  const statuses = ["succeeded", "failed", "timed_out", "cancelled", "lost"] as const;
  const rows = Array.from({ length: 1_000 }, (_, index) => {
    const status = statuses[index % statuses.length]!;
    const record = task(`fixed-${index}`, status);
    const run = registerRun(record, {
      pauseReason: "sessions_yield",
      execution: { status: "terminal", endedAt: 2 },
    });
    const timestamp = [undefined, 0, 42][Math.floor(index / statuses.length) % 3];
    if (timestamp !== undefined) {
      recordTaskActivityEvent(record, {
        runId: run.runId,
        seq: 1,
        stream: "tool",
        ts: timestamp,
        data: { phase: "start", name: "stale_tool", toolCallId: "old-tool" },
      });
      recordTaskActivityEvent(record, {
        runId: run.runId,
        seq: 2,
        stream: "execution",
        ts: timestamp,
        data: { state: "waiting", wait: { kind: "approval" } },
      });
    }
    return { record, run, timestamp };
  });
  const before = structuredClone(rows);
  const observe = vi.spyOn(nativeExecution, "getSubagentExecutionObservation");

  expect(rows.map(({ record }) => getTaskExecutionObservation(record))).toEqual(
    rows.map(({ record, timestamp }) => ({
      state: record.status === "lost" ? "unknown" : "finished",
      ...(timestamp !== undefined ? { lastActivityAt: timestamp } : {}),
    })),
  );
  expect(rows).toEqual(before);
  expect(observe).toHaveBeenCalledTimes(0);
});

it("keeps running task observations current through generation replacement and deletion", () => {
  const record = task("running-task", "running");
  const original = registerRun(record);
  claimAgentRunContext(
    original.runId,
    { sessionKey: original.childSessionKey },
    { trackOwner: true, ownsContext: true },
  );
  recordTaskActivityEvent(record, {
    runId: original.runId,
    seq: 1,
    stream: "tool",
    ts: 10,
    data: { phase: "start", name: "old_tool", toolCallId: "old-tool" },
  });
  expect(getTaskExecutionObservation(record)).toEqual({
    state: "running",
    lastActivityAt: 10,
    currentTool: { name: "old_tool", startedAt: 10 },
  });

  const successor = registerRun(record, {
    runId: "successor",
    taskRunId: original.runId,
    generation: 2,
    pauseReason: "sessions_yield",
    execution: { status: "terminal", endedAt: 20 },
  });
  expect(getTaskExecutionObservation(record)).toEqual({ state: "unknown", lastActivityAt: 10 });
  record.detail = createSubagentTaskBackingDetail(2);
  expect(getTaskExecutionObservation(record)).toEqual({
    state: "waiting",
    wait: { kind: "external" },
    lastActivityAt: 10,
  });

  successor.pauseReason = undefined;
  successor.execution = { status: "running", startedAt: 30 };
  claimAgentRunContext(
    successor.runId,
    { sessionKey: successor.childSessionKey },
    { trackOwner: true, ownsContext: true },
  );
  recordTaskActivityEvent(record, {
    runId: successor.runId,
    seq: 1,
    stream: "tool",
    ts: 30,
    data: { phase: "start", name: "  read_file  ", toolCallId: "new-tool" },
  });
  expect(getTaskExecutionObservation(record)).toEqual({
    state: "running",
    lastActivityAt: 30,
    currentTool: { name: "read_file", startedAt: 30 },
  });
  subagentRuns.delete(successor.runId);
  subagentRuns.delete(original.runId);
  expect(getTaskExecutionObservation(record)).toEqual({ state: "unknown", lastActivityAt: 30 });
});

it("observes background exec ownership through silence, removal, cleanup, and exit", () => {
  const process = createProcessSessionFixture({ id: "quiet-copy", startedAt: 1_000 });
  process.sessionKey = "agent:main:main";
  const activity = { resultSettled: false, lastOutputAtMs: 1_000 };
  process.processActivity = activity;
  addSession(process);
  const record: TaskRecord = {
    ...task("exec-task", "running"),
    runtime: "cli",
    taskKind: "exec",
    runId: "exec:quiet-copy",
    sourceId: process.id,
    childSessionKey: undefined,
    detail: undefined,
    startedAt: process.startedAt,
  };
  expect(getTaskExecutionObservation(record)).toEqual({ state: "unknown" });
  markBackgrounded(process);
  vi.setSystemTime(process.startedAt + 53 * 60_000);
  expect(getTaskExecutionObservation(record)).toEqual({ state: "running", lastActivityAt: 1_000 });
  expect(getTaskExecutionObservation({ ...record, ownerKey: "agent:other:main" })).toEqual({
    state: "unknown",
  });
  activity.lastOutputAtMs = 2_000;
  deleteSession(process.id);
  expect(getTaskExecutionObservation(record)).toEqual({ state: "running", lastActivityAt: 2_000 });
  activity.resultSettled = true;
  process.finalizing = true;
  expect(getTaskExecutionObservation(record)).toEqual({
    state: "waiting",
    wait: { kind: "external" },
    lastActivityAt: 2_000,
  });
  markExited(process, 0, null, "completed", "exit");
  record.status = "succeeded";
  expect(getTaskExecutionObservation(record)).toEqual({ state: "finished" });
  record.status = "running";
  resetProcessRegistryForTests();
  expect(getTaskExecutionObservation(record)).toEqual({ state: "unknown" });
  const replacement = createProcessSessionFixture({
    id: process.id,
    startedAt: 5_000,
    backgrounded: true,
  });
  replacement.sessionKey = process.sessionKey;
  addSession(replacement);
  expect(getTaskExecutionObservation(record)).toEqual({ state: "unknown" });
});
