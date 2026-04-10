import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentWaitResult } from "../run-wait.js";
import type { SpawnSubagentResult } from "../subagent-spawn.js";

// Mock spawnSubagentDirect, waitForAgentRun, readLatestAssistantReply, and subagentRuns.
const spawnSubagentDirectMock = vi.fn<(...args: unknown[]) => Promise<SpawnSubagentResult>>();
const waitForAgentRunMock = vi.fn<(...args: unknown[]) => Promise<AgentWaitResult>>();
const readLatestAssistantReplyMock = vi.fn<(...args: unknown[]) => Promise<string | undefined>>();
const subagentRunsMap = new Map<string, { frozenResultText?: string | null }>();

vi.mock("../subagent-spawn.js", () => ({
  spawnSubagentDirect: (...args: unknown[]) => spawnSubagentDirectMock(...args),
}));

vi.mock("../run-wait.js", () => ({
  waitForAgentRun: (...args: unknown[]) => waitForAgentRunMock(...args),
  readLatestAssistantReply: (...args: unknown[]) => readLatestAssistantReplyMock(...args),
}));

vi.mock("../subagent-registry-memory.js", () => ({
  subagentRuns: subagentRunsMap,
}));

// Import after mocks are set up.
const { createSessionsDelegateTool, createSessionsDelegateBatchTool } =
  await import("./sessions-delegate-tool.js");

function makeAcceptedSpawn(overrides?: Partial<SpawnSubagentResult>): SpawnSubagentResult {
  return {
    status: "accepted",
    childSessionKey: "agent:main:subagent:child-1",
    runId: "run-1",
    mode: "run",
    ...overrides,
  };
}

describe("sessions_delegate", () => {
  const tool = createSessionsDelegateTool();

  beforeEach(() => {
    spawnSubagentDirectMock.mockReset();
    waitForAgentRunMock.mockReset();
    readLatestAssistantReplyMock.mockReset();
    subagentRunsMap.clear();
  });

  it("spawns a child, waits, and returns the frozen result", async () => {
    spawnSubagentDirectMock.mockResolvedValue(makeAcceptedSpawn());
    waitForAgentRunMock.mockResolvedValue({ status: "ok" });
    subagentRunsMap.set("run-1", { frozenResultText: "Child output here." });

    const result = await tool.execute("call-1", { task: "Do something" });
    const payload = result.details as Record<string, unknown>;

    expect(payload.status).toBe("ok");
    expect(payload.output).toBe("Child output here.");
    expect(payload.runId).toBe("run-1");
    expect(payload.childSessionKey).toBe("agent:main:subagent:child-1");
    expect(typeof payload.runtimeMs).toBe("number");
  });

  it("falls back to readLatestAssistantReply when frozenResultText is absent", async () => {
    spawnSubagentDirectMock.mockResolvedValue(makeAcceptedSpawn());
    waitForAgentRunMock.mockResolvedValue({ status: "ok" });
    readLatestAssistantReplyMock.mockResolvedValue("Fallback reply.");

    const result = await tool.execute("call-1", { task: "Do something" });
    const payload = result.details as Record<string, unknown>;

    expect(payload.status).toBe("ok");
    expect(payload.output).toBe("Fallback reply.");
    expect(readLatestAssistantReplyMock).toHaveBeenCalled();
  });

  it("returns error when spawn fails", async () => {
    spawnSubagentDirectMock.mockResolvedValue({
      status: "error",
      error: "Max spawn depth exceeded.",
    });

    const result = await tool.execute("call-1", { task: "Do something" });
    const payload = result.details as Record<string, unknown>;

    expect(payload.status).toBe("error");
    expect(payload.error).toBe("Max spawn depth exceeded.");
    expect(waitForAgentRunMock).not.toHaveBeenCalled();
  });

  it("returns forbidden when spawn is forbidden", async () => {
    spawnSubagentDirectMock.mockResolvedValue({
      status: "forbidden",
      error: "Sandboxed.",
    });

    const result = await tool.execute("call-1", { task: "Do something" });
    const payload = result.details as Record<string, unknown>;

    expect(payload.status).toBe("forbidden");
  });

  it("returns timeout when child run times out", async () => {
    spawnSubagentDirectMock.mockResolvedValue(makeAcceptedSpawn());
    waitForAgentRunMock.mockResolvedValue({ status: "timeout" });

    const result = await tool.execute("call-1", { task: "Do something", timeoutSeconds: 1 });
    const payload = result.details as Record<string, unknown>;

    expect(payload.status).toBe("timeout");
    expect(payload.runId).toBe("run-1");
  });

  it("passes expectsCompletionMessage: false to spawnSubagentDirect", async () => {
    spawnSubagentDirectMock.mockResolvedValue(makeAcceptedSpawn());
    waitForAgentRunMock.mockResolvedValue({ status: "ok" });
    subagentRunsMap.set("run-1", { frozenResultText: "done" });

    await tool.execute("call-1", { task: "test" });

    const spawnParams = spawnSubagentDirectMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(spawnParams.expectsCompletionMessage).toBe(false);
  });
});

describe("sessions_delegate_batch", () => {
  const tool = createSessionsDelegateBatchTool();

  beforeEach(() => {
    spawnSubagentDirectMock.mockReset();
    waitForAgentRunMock.mockReset();
    readLatestAssistantReplyMock.mockReset();
    subagentRunsMap.clear();
  });

  it("fans out multiple tasks and collects results", async () => {
    let spawnCount = 0;
    spawnSubagentDirectMock.mockImplementation(async () => {
      spawnCount++;
      return makeAcceptedSpawn({
        childSessionKey: `agent:main:subagent:child-${spawnCount}`,
        runId: `run-${spawnCount}`,
      });
    });
    waitForAgentRunMock.mockResolvedValue({ status: "ok" });
    subagentRunsMap.set("run-1", { frozenResultText: "Result A" });
    subagentRunsMap.set("run-2", { frozenResultText: "Result B" });
    subagentRunsMap.set("run-3", { frozenResultText: "Result C" });

    const result = await tool.execute("call-1", {
      tasks: [{ task: "Research Acme" }, { task: "Research Beta" }, { task: "Research Gamma" }],
    });
    const payload = result.details as Record<string, unknown>;

    expect(payload.status).toBe("ok");
    const summary = payload.summary as Record<string, number>;
    expect(summary.total).toBe(3);
    expect(summary.completed).toBe(3);
    expect(summary.failed).toBe(0);
    expect(summary.timedOut).toBe(0);
  });

  it("returns partial results when one task fails and failureMode is partial", async () => {
    let spawnCount = 0;
    spawnSubagentDirectMock.mockImplementation(async () => {
      spawnCount++;
      if (spawnCount === 2) {
        return { status: "error" as const, error: "Agent not found" };
      }
      return makeAcceptedSpawn({
        childSessionKey: `agent:main:subagent:child-${spawnCount}`,
        runId: `run-${spawnCount}`,
      });
    });
    waitForAgentRunMock.mockResolvedValue({ status: "ok" });
    subagentRunsMap.set("run-1", { frozenResultText: "Result A" });
    subagentRunsMap.set("run-3", { frozenResultText: "Result C" });

    const result = await tool.execute("call-1", {
      tasks: [{ task: "Task 1" }, { task: "Task 2" }, { task: "Task 3" }],
      failureMode: "partial",
    });
    const payload = result.details as Record<string, unknown>;

    expect(payload.status).toBe("partial");
    const summary = payload.summary as Record<string, number>;
    expect(summary.completed).toBe(2);
    expect(summary.failed).toBe(1);
  });

  it("returns error status when any task fails and failureMode is all", async () => {
    let spawnCount = 0;
    spawnSubagentDirectMock.mockImplementation(async () => {
      spawnCount++;
      if (spawnCount === 2) {
        return { status: "error" as const, error: "Failed" };
      }
      return makeAcceptedSpawn({
        childSessionKey: `agent:main:subagent:child-${spawnCount}`,
        runId: `run-${spawnCount}`,
      });
    });
    waitForAgentRunMock.mockResolvedValue({ status: "ok" });
    subagentRunsMap.set("run-1", { frozenResultText: "Result A" });

    const result = await tool.execute("call-1", {
      tasks: [{ task: "Task 1" }, { task: "Task 2" }],
      failureMode: "all",
    });
    const payload = result.details as Record<string, unknown>;

    expect(payload.status).toBe("error");
  });

  it("rejects empty tasks array", async () => {
    await expect(tool.execute("call-1", { tasks: [] })).rejects.toThrow(
      "tasks must be a non-empty array",
    );
  });
});
