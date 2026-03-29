import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "../cli/test-runtime-capture.js";

const reconcileInspectableTasksMock = vi.fn();
const reconcileTaskLookupTokenMock = vi.fn();
const updateTaskNotifyPolicyByIdMock = vi.fn();
const cancelTaskByIdMock = vi.fn();
const getTaskByIdMock = vi.fn();
const loadConfigMock = vi.fn(() => ({ loaded: true }));

vi.mock("../tasks/task-registry.reconcile.js", () => ({
  reconcileInspectableTasks: (...args: unknown[]) => reconcileInspectableTasksMock(...args),
  reconcileTaskLookupToken: (...args: unknown[]) => reconcileTaskLookupTokenMock(...args),
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

const taskFixture = {
  taskId: "task-12345678",
  source: "sessions_spawn",
  runtime: "acp",
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
  ({ tasksListCommand, tasksShowCommand, tasksNotifyCommand, tasksCancelCommand } =
    await import("./tasks.js"));
});

describe("tasks commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRuntimeCapture();
    reconcileInspectableTasksMock.mockReturnValue([]);
    reconcileTaskLookupTokenMock.mockReturnValue(undefined);
    updateTaskNotifyPolicyByIdMock.mockReturnValue(undefined);
    cancelTaskByIdMock.mockResolvedValue({ found: false, cancelled: false, reason: "missing" });
    getTaskByIdMock.mockReturnValue(undefined);
  });

  it("lists task rows with progress summary fallback", async () => {
    reconcileInspectableTasksMock.mockReturnValue([taskFixture]);

    await tasksListCommand({ runtime: "acp", status: "running" }, runtime);

    expect(runtimeLogs[0]).toContain("Background tasks: 1");
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
});
