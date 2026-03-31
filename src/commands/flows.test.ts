import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "../cli/test-runtime-capture.js";
import { flowsCancelCommand, flowsListCommand, flowsShowCommand } from "./flows.js";

const mocks = vi.hoisted(() => ({
  listFlowRecordsMock: vi.fn(),
  resolveFlowForLookupTokenMock: vi.fn(),
  getFlowByIdMock: vi.fn(),
  listTasksForFlowIdMock: vi.fn(),
  getFlowTaskSummaryMock: vi.fn(),
  cancelFlowByIdMock: vi.fn(),
  loadConfigMock: vi.fn(() => ({ loaded: true })),
}));

vi.mock("../tasks/flow-registry.js", () => ({
  listFlowRecords: (...args: unknown[]) => mocks.listFlowRecordsMock(...args),
  resolveFlowForLookupToken: (...args: unknown[]) => mocks.resolveFlowForLookupTokenMock(...args),
  getFlowById: (...args: unknown[]) => mocks.getFlowByIdMock(...args),
}));

vi.mock("../tasks/task-registry.js", () => ({
  listTasksForFlowId: (...args: unknown[]) => mocks.listTasksForFlowIdMock(...args),
}));

vi.mock("../tasks/task-executor.js", () => ({
  getFlowTaskSummary: (...args: unknown[]) => mocks.getFlowTaskSummaryMock(...args),
  cancelFlowById: (...args: unknown[]) => mocks.cancelFlowByIdMock(...args),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: () => mocks.loadConfigMock(),
}));

const {
  defaultRuntime: runtime,
  runtimeLogs,
  runtimeErrors,
  resetRuntimeCapture,
} = createCliRuntimeCapture();

const flowFixture = {
  flowId: "flow-12345678",
  shape: "linear",
  ownerSessionKey: "agent:main:main",
  status: "waiting",
  notifyPolicy: "done_only",
  goal: "Process related PRs",
  currentStep: "wait_for",
  createdAt: Date.parse("2026-03-31T10:00:00.000Z"),
  updatedAt: Date.parse("2026-03-31T10:05:00.000Z"),
} as const;

const taskSummaryFixture = {
  total: 2,
  active: 1,
  terminal: 1,
  failures: 0,
  byStatus: {
    queued: 0,
    running: 1,
    succeeded: 1,
    failed: 0,
    timed_out: 0,
    cancelled: 0,
    lost: 0,
  },
  byRuntime: {
    subagent: 1,
    acp: 1,
    cli: 0,
    cron: 0,
  },
} as const;

const taskFixture = {
  taskId: "task-12345678",
  runtime: "acp",
  requesterSessionKey: "agent:main:main",
  parentFlowId: "flow-12345678",
  childSessionKey: "agent:codex:acp:child",
  runId: "run-12345678",
  task: "Review PR",
  status: "running",
  deliveryStatus: "pending",
  notifyPolicy: "done_only",
  createdAt: Date.parse("2026-03-31T10:00:00.000Z"),
  lastEventAt: Date.parse("2026-03-31T10:05:00.000Z"),
} as const;

describe("flows commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRuntimeCapture();
    mocks.listFlowRecordsMock.mockReturnValue([]);
    mocks.resolveFlowForLookupTokenMock.mockReturnValue(undefined);
    mocks.getFlowByIdMock.mockReturnValue(undefined);
    mocks.listTasksForFlowIdMock.mockReturnValue([]);
    mocks.getFlowTaskSummaryMock.mockReturnValue(taskSummaryFixture);
    mocks.cancelFlowByIdMock.mockResolvedValue({
      found: false,
      cancelled: false,
      reason: "missing",
    });
  });

  it("lists flow rows with task summary counts", async () => {
    mocks.listFlowRecordsMock.mockReturnValue([flowFixture]);

    await flowsListCommand({}, runtime);

    expect(runtimeLogs[0]).toContain("Flows: 1");
    expect(runtimeLogs[1]).toContain("Flow pressure: 0 active · 0 blocked · 1 total");
    expect(runtimeLogs.join("\n")).toContain("Process related PRs");
    expect(runtimeLogs.join("\n")).toContain("1 active/2 total");
  });

  it("shows one flow with linked tasks", async () => {
    mocks.resolveFlowForLookupTokenMock.mockReturnValue(flowFixture);
    mocks.listTasksForFlowIdMock.mockReturnValue([taskFixture]);

    await flowsShowCommand({ lookup: "flow-12345678" }, runtime);

    expect(runtimeLogs.join("\n")).toContain("shape: linear");
    expect(runtimeLogs.join("\n")).toContain("currentStep: wait_for");
    expect(runtimeLogs.join("\n")).toContain("tasks: 2 total · 1 active · 0 issues");
    expect(runtimeLogs.join("\n")).toContain("task-12345678 running run-12345678 Review PR");
  });

  it("cancels a flow and reports the updated state", async () => {
    mocks.resolveFlowForLookupTokenMock.mockReturnValue(flowFixture);
    mocks.cancelFlowByIdMock.mockResolvedValue({
      found: true,
      cancelled: true,
      flow: {
        ...flowFixture,
        status: "cancelled",
      },
    });
    mocks.getFlowByIdMock.mockReturnValue({
      ...flowFixture,
      status: "cancelled",
    });

    await flowsCancelCommand({ lookup: "flow-12345678" }, runtime);

    expect(mocks.loadConfigMock).toHaveBeenCalled();
    expect(mocks.cancelFlowByIdMock).toHaveBeenCalledWith({
      cfg: { loaded: true },
      flowId: "flow-12345678",
    });
    expect(runtimeLogs[0]).toContain("Cancelled flow-12345678 (linear) with status cancelled.");
    expect(runtimeErrors).toEqual([]);
  });
});
