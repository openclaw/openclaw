import { describe, expect, it } from "vitest";
import { listTaskAuditFindings } from "./task-registry.audit.js";
import { buildTaskStatusSnapshot } from "./task-status.js";
import { isActiveTaskStatus, type TaskRecord } from "./task-registry.types.js";

const NOW = 1_000_000_000_000;

function makeTask(overrides: Partial<TaskRecord>): TaskRecord {
  return {
    taskId: overrides.taskId ?? "task-1",
    runId: overrides.runId ?? "run-1",
    task: overrides.task ?? "default task",
    runtime: overrides.runtime ?? "subagent",
    status: overrides.status ?? "running",
    requesterSessionKey: overrides.requesterSessionKey ?? "agent:main:main",
    ownerKey: overrides.ownerKey ?? "agent:main:main",
    scopeKind: overrides.scopeKind ?? "session",
    createdAt: overrides.createdAt ?? NOW - 1_000,
    deliveryStatus: overrides.deliveryStatus ?? "pending",
    notifyPolicy: overrides.notifyPolicy ?? "done_only",
    ...overrides,
  };
}

describe("isActiveTaskStatus", () => {
  it("treats intermediate task states as active", () => {
    expect(isActiveTaskStatus("queued")).toBe(true);
    expect(isActiveTaskStatus("awaiting_approval")).toBe(true);
    expect(isActiveTaskStatus("waiting_external")).toBe(true);
    expect(isActiveTaskStatus("running")).toBe(true);
    expect(isActiveTaskStatus("succeeded")).toBe(false);
  });
});

describe("task audit active-state semantics", () => {
  it("does not require cleanupAfter for intermediate active states", () => {
    const findings = listTaskAuditFindings({
      now: NOW,
      tasks: [
        makeTask({ taskId: "approval", status: "awaiting_approval", lastEventAt: NOW - 60_000 }),
        makeTask({ taskId: "external", status: "waiting_external", lastEventAt: NOW - 60_000 }),
      ],
    });

    expect(findings.find((finding) => finding.code === "missing_cleanup")).toBeUndefined();
  });

  it("uses distinct stale audit codes for approval and external waits", () => {
    const findings = listTaskAuditFindings({
      now: NOW,
      staleAwaitingApprovalMs: 60_000,
      staleWaitingExternalMs: 60_000,
      tasks: [
        makeTask({ taskId: "approval", status: "awaiting_approval", lastEventAt: NOW - 120_000 }),
        makeTask({ taskId: "external", status: "waiting_external", lastEventAt: NOW - 120_000 }),
      ],
    });

    expect(findings.find((finding) => finding.code === "stale_awaiting_approval")?.severity).toBe("warn");
    expect(findings.find((finding) => finding.code === "stale_waiting_external")?.severity).toBe("warn");
  });

  it("flags endedAt on intermediate active states as inconsistent timestamps", () => {
    const findings = listTaskAuditFindings({
      now: NOW,
      tasks: [
        makeTask({
          taskId: "approval",
          status: "awaiting_approval",
          startedAt: NOW - 2_000,
          endedAt: NOW - 1_000,
        }),
        makeTask({
          taskId: "external",
          status: "waiting_external",
          startedAt: NOW - 2_000,
          endedAt: NOW - 1_000,
        }),
      ],
    });

    expect(findings.filter((finding) => finding.code === "inconsistent_timestamps")).toHaveLength(2);
  });
});

describe("task status snapshot active-state semantics", () => {
  it("keeps waiting_external tasks in the active snapshot", () => {
    const task = makeTask({
      taskId: "wait-1",
      status: "waiting_external",
      progressSummary: "Waiting for external system.",
      lastEventAt: NOW - 500,
    });

    const snapshot = buildTaskStatusSnapshot([task], { now: NOW });
    expect(snapshot.activeCount).toBe(1);
    expect(snapshot.focus?.taskId).toBe("wait-1");
    expect(snapshot.focus?.status).toBe("waiting_external");
  });
});
