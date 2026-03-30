import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "../cli/test-runtime-capture.js";

const reconcileInspectableTasksMock = vi.fn();
const reconcileTaskLookupTokenMock = vi.fn();
const listTaskAuditFindingsMock = vi.fn();
const summarizeTaskAuditFindingsMock = vi.fn();
const updateTaskNotifyPolicyByIdMock = vi.fn();
const cancelTaskByIdMock = vi.fn();
const getTaskByIdMock = vi.fn();
const loadConfigMock = vi.fn(() => ({ loaded: true }));

vi.mock("../tasks/task-registry.reconcile.js", () => ({
  reconcileInspectableTasks: (...args: unknown[]) => reconcileInspectableTasksMock(...args),
  reconcileTaskLookupToken: (...args: unknown[]) => reconcileTaskLookupTokenMock(...args),
}));

vi.mock("../tasks/task-registry.audit.js", () => ({
  listTaskAuditFindings: (...args: unknown[]) => listTaskAuditFindingsMock(...args),
  summarizeTaskAuditFindings: (...args: unknown[]) => summarizeTaskAuditFindingsMock(...args),
}));

vi.mock("../tasks/task-registry.js", () => ({
  updateTaskNotifyPolicyById: (...args: unknown[]) => updateTaskNotifyPolicyByIdMock(...args),
  cancelTaskById: (...args: unknown[]) => cancelTaskByIdMock(...args),
  getTaskById: (...args: unknown[]) => getTaskByIdMock(...args),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: () => loadConfigMock(),
}));

const {
  defaultRuntime: runtime,
  runtimeLogs,
  runtimeErrors,
  resetRuntimeCapture,
} = createCliRuntimeCapture();

let tasksListCommand: typeof import("./tasks.js").tasksListCommand;
let tasksShowCommand: typeof import("./tasks.js").tasksShowCommand;
let tasksNotifyCommand: typeof import("./tasks.js").tasksNotifyCommand;
let tasksCancelCommand: typeof import("./tasks.js").tasksCancelCommand;
let tasksAuditCommand: typeof import("./tasks.js").tasksAuditCommand;

const taskFixture = {
  taskId: "task-12345678",
  runtime: "acp",
  sourceId: "run-12345678",
  requesterSessionKey: "agent:main:main",
  childSessionKey: "agent:codex:acp:child",
  runId: "run-12345678",
  task: "Create a file",
  status: "running",
  deliveryStatus: "pending",
  notifyPolicy: "state_changes",
  createdAt: Date.parse("2026-03-29T10:00:00.000Z"),
  lastEventAt: Date.parse("2026-03-29T10:00:10.000Z"),
  progressSummary: "No output for 60s. It may be waiting for input.",
  recentEvents: [
    {
      at: Date.parse("2026-03-29T10:00:10.000Z"),
      kind: "progress",
      summary: "No output for 60s. It may be waiting for input.",
    },
  ],
} as const;

beforeAll(async () => {
  ({
    tasksListCommand,
    tasksShowCommand,
    tasksNotifyCommand,
    tasksCancelCommand,
    tasksAuditCommand,
  } = await import("./tasks.js"));
});

describe("tasks commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRuntimeCapture();
    reconcileInspectableTasksMock.mockReturnValue([]);
    reconcileTaskLookupTokenMock.mockReturnValue(undefined);
    listTaskAuditFindingsMock.mockReturnValue([]);
    summarizeTaskAuditFindingsMock.mockReturnValue({
      total: 0,
      warnings: 0,
      errors: 0,
      byCode: {
        stale_queued: 0,
        stale_running: 0,
        lost: 0,
        delivery_failed: 0,
        missing_cleanup: 0,
        inconsistent_timestamps: 0,
      },
    });
    updateTaskNotifyPolicyByIdMock.mockReturnValue(undefined);
    cancelTaskByIdMock.mockResolvedValue({ found: false, cancelled: false, reason: "missing" });
    getTaskByIdMock.mockReturnValue(undefined);
  });

  it("lists task rows with progress summary fallback", async () => {
    reconcileInspectableTasksMock.mockReturnValue([taskFixture]);

    await tasksListCommand({ runtime: "acp", status: "running" }, runtime);

    expect(runtimeLogs[0]).toContain("Background tasks: 1");
    expect(runtimeLogs[1]).toContain("Task pressure: 0 queued · 1 running · 0 issues");
    expect(runtimeLogs.join("\n")).toContain("No output for 60s. It may be waiting for input.");
  });

  it("shows detailed task fields including notify and recent events", async () => {
    reconcileTaskLookupTokenMock.mockReturnValue(taskFixture);

    await tasksShowCommand({ lookup: "run-12345678" }, runtime);

    expect(runtimeLogs.join("\n")).toContain("notify: state_changes");
    expect(runtimeLogs.join("\n")).toContain(
      "progressSummary: No output for 60s. It may be waiting for input.",
    );
    expect(runtimeLogs.join("\n")).toContain("recentEvent[0]: 2026-03-29T10:00:10.000Z progress");
  });

  it("updates notify policy for an existing task", async () => {
    reconcileTaskLookupTokenMock.mockReturnValue(taskFixture);
    updateTaskNotifyPolicyByIdMock.mockReturnValue({
      ...taskFixture,
      notifyPolicy: "silent",
    });

    await tasksNotifyCommand({ lookup: "run-12345678", notify: "silent" }, runtime);

    expect(updateTaskNotifyPolicyByIdMock).toHaveBeenCalledWith({
      taskId: "task-12345678",
      notifyPolicy: "silent",
    });
    expect(runtimeLogs[0]).toContain("Updated task-12345678 notify policy to silent.");
  });

  it("cancels a running task and reports the updated runtime", async () => {
    reconcileTaskLookupTokenMock.mockReturnValue(taskFixture);
    cancelTaskByIdMock.mockResolvedValue({
      found: true,
      cancelled: true,
      task: {
        ...taskFixture,
        status: "cancelled",
      },
    });
    getTaskByIdMock.mockReturnValue({
      ...taskFixture,
      status: "cancelled",
    });

    await tasksCancelCommand({ lookup: "run-12345678" }, runtime);

    expect(loadConfigMock).toHaveBeenCalled();
    expect(cancelTaskByIdMock).toHaveBeenCalledWith({
      cfg: { loaded: true },
      taskId: "task-12345678",
    });
    expect(runtimeLogs[0]).toContain("Cancelled task-12345678 (acp) run run-12345678.");
    expect(runtimeErrors).toEqual([]);
  });

  it("shows task audit findings with filters", async () => {
    listTaskAuditFindingsMock.mockReturnValue([
      {
        severity: "error",
        code: "stale_running",
        task: taskFixture,
        ageMs: 45 * 60_000,
        detail: "running task appears stuck",
      },
    ]);
    summarizeTaskAuditFindingsMock.mockReturnValue({
      total: 1,
      warnings: 0,
      errors: 1,
      byCode: {
        stale_queued: 0,
        stale_running: 1,
        lost: 0,
        delivery_failed: 0,
        missing_cleanup: 0,
        inconsistent_timestamps: 0,
      },
    });

    await tasksAuditCommand({ severity: "error", code: "stale_running", limit: 1 }, runtime);

    expect(runtimeLogs[0]).toContain("Task audit: 1 findings · 1 errors · 0 warnings");
    expect(runtimeLogs.join("\n")).toContain("stale_running");
    expect(runtimeLogs.join("\n")).toContain("running task appears stuck");
  });
});
