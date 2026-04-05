import { beforeEach, describe, expect, it, vi } from "vitest";
import { subagentRuns } from "../../../agents/subagent-registry-memory.js";

const { loadSessionStoreMock, resolveStorePathMock, findTaskByRunIdForOwnerMock } = vi.hoisted(
  () => ({
    loadSessionStoreMock: vi.fn<(storePath: string) => Record<string, unknown>>(() => ({})),
    resolveStorePathMock: vi.fn<(store?: string, opts?: { agentId?: string }) => string>(
      () => "/tmp/test-sessions.json",
    ),
    findTaskByRunIdForOwnerMock: vi.fn<(params: unknown) => unknown>(() => null),
  }),
);

vi.mock("../../../config/sessions/store-load.js", () => ({
  loadSessionStore: (storePath: string) => loadSessionStoreMock(storePath),
}));

vi.mock("../../../config/sessions/paths.js", () => ({
  resolveStorePath: (store?: string, opts?: { agentId?: string }) =>
    resolveStorePathMock(store, opts),
}));

vi.mock("../../../tasks/task-owner-access.js", () => ({
  findTaskByRunIdForOwner: (params: unknown) => findTaskByRunIdForOwnerMock(params),
}));

let handleSubagentsInfoAction: typeof import("./action-info.js").handleSubagentsInfoAction;

describe("handleSubagentsInfoAction", () => {
  beforeEach(async () => {
    vi.resetModules();
    subagentRuns.clear();
    loadSessionStoreMock.mockReset().mockReturnValue({});
    resolveStorePathMock.mockReset().mockReturnValue("/tmp/test-sessions.json");
    findTaskByRunIdForOwnerMock.mockReset().mockReturnValue(null);
    ({ handleSubagentsInfoAction } = await import("./action-info.js"));
  });

  it("renders subagent info with linked task fields", () => {
    const now = Date.now();
    const run = {
      runId: "run-1",
      childSessionKey: "agent:main:subagent:abc",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      cleanup: "keep" as const,
      createdAt: now - 20_000,
      startedAt: now - 20_000,
      endedAt: now - 1_000,
      outcome: { status: "ok" as const },
    };
    subagentRuns.set(run.runId, run);
    loadSessionStoreMock.mockReturnValue({
      "agent:main:subagent:abc": {
        sessionId: "session-abc",
        sessionFile: "abc.jsonl",
        updatedAt: now,
      },
    });
    findTaskByRunIdForOwnerMock.mockReturnValue({
      taskId: "task-1",
      status: "succeeded",
      progressSummary: "working",
      terminalSummary: "Completed the requested task",
      deliveryStatus: "delivered",
    } as never);

    const result = handleSubagentsInfoAction({
      params: { cfg: {}, sessionKey: "agent:main:main" },
      runs: [run],
      restTokens: ["1"],
    } as never);

    expect(result.reply?.text).toContain("Subagent info");
    expect(result.reply?.text).toContain("Run: run-1");
    expect(result.reply?.text).toContain("Status: done");
    expect(result.reply?.text).toContain("TaskId: task-1");
    expect(result.reply?.text).toContain("Task summary: Completed the requested task");
  });

  it("sanitizes leaked task details in outcome and task fields", () => {
    const now = Date.now();
    const leaked = [
      "OpenClaw runtime context (internal):",
      "This context is runtime-generated, not user-authored. Keep internal details private.",
      "",
      "[Internal task completion event]",
      "source: subagent",
    ].join("\n");
    const run = {
      runId: "run-1",
      childSessionKey: "agent:main:subagent:abc",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "Inspect the stuck run",
      cleanup: "keep" as const,
      createdAt: now - 20_000,
      startedAt: now - 20_000,
      endedAt: now - 1_000,
      outcome: { status: "error" as const, error: leaked },
    };
    subagentRuns.set(run.runId, run);
    findTaskByRunIdForOwnerMock.mockReturnValue({
      taskId: "task-1",
      status: "failed",
      terminalSummary: "Needs manual follow-up.",
      error: leaked,
      deliveryStatus: "delivered",
    } as never);

    const result = handleSubagentsInfoAction({
      params: { cfg: {}, sessionKey: "agent:main:main" },
      runs: [run],
      restTokens: ["1"],
    } as never);

    expect(result.reply?.text).toContain("Outcome: error");
    expect(result.reply?.text).toContain("Task summary: Needs manual follow-up.");
    expect(result.reply?.text).not.toContain("OpenClaw runtime context (internal):");
    expect(result.reply?.text).not.toContain("Internal task completion event");
  });
});
