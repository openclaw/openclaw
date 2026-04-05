import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadSessionStoreMock, resolveStorePathMock } = vi.hoisted(() => ({
  loadSessionStoreMock: vi.fn<(storePath: string) => Record<string, unknown>>(() => ({})),
  resolveStorePathMock: vi.fn<(store?: string, opts?: { agentId?: string }) => string>(
    () => "/tmp/test-sessions.json",
  ),
}));

vi.mock("../../../config/sessions/store-load.js", () => ({
  loadSessionStore: (storePath: string) => loadSessionStoreMock(storePath),
}));

vi.mock("../../../config/sessions/paths.js", () => ({
  resolveStorePath: (store?: string, opts?: { agentId?: string }) =>
    resolveStorePathMock(store, opts),
}));

let handleSubagentsListAction: typeof import("./action-list.js").handleSubagentsListAction;
let subagentRuns: typeof import("../../../agents/subagent-registry-memory.js").subagentRuns;

describe("handleSubagentsListAction", () => {
  beforeEach(async () => {
    vi.resetModules();
    loadSessionStoreMock.mockReset().mockReturnValue({});
    resolveStorePathMock.mockReset().mockReturnValue("/tmp/test-sessions.json");
    ({ subagentRuns } = await import("../../../agents/subagent-registry-memory.js"));
    subagentRuns.clear();
    ({ handleSubagentsListAction } = await import("./action-list.js"));
  });

  it("renders empty active and recent sections when no runs exist", () => {
    const result = handleSubagentsListAction({
      params: { cfg: {} },
      runs: [],
    } as never);

    expect(result.reply?.text).toContain("active subagents:\n-----\n(none)");
    expect(result.reply?.text).toContain("recent subagents (last 30m):\n-----\n(none)");
  });

  it("truncates long task text with ASCII ellipsis", () => {
    const run = {
      runId: "run-long-task",
      childSessionKey: "agent:main:subagent:long-task",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "This is a deliberately long task description used to verify that subagent list output keeps the full task text instead of appending ellipsis after a short hard cutoff.",
      cleanup: "keep" as const,
      createdAt: 1_000,
      startedAt: 1_000,
    };

    subagentRuns.set(run.runId, run);

    const result = handleSubagentsListAction({
      params: { cfg: {} },
      runs: [run],
    } as never);

    expect(result.reply?.text).toContain(
      "This is a deliberately long task description used to verify that subagent list output keeps the full task text",
    );
    expect(result.reply?.text).toContain("...");
    expect(result.reply?.text).not.toContain("after a short hard cutoff.");
  });

  it("keeps ended orchestrators in active list while descendants are pending", () => {
    const now = Date.now();
    const parent = {
      runId: "run-orchestrator-ended",
      childSessionKey: "agent:main:subagent:orchestrator-ended",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "orchestrate child workers",
      cleanup: "keep" as const,
      createdAt: now - 120_000,
      startedAt: now - 120_000,
      endedAt: now - 60_000,
      outcome: { status: "ok" as const },
    };
    const child = {
      runId: "run-orchestrator-child-active",
      childSessionKey: "agent:main:subagent:orchestrator-ended:subagent:child",
      requesterSessionKey: "agent:main:subagent:orchestrator-ended",
      requesterDisplayKey: "subagent:orchestrator-ended",
      task: "child worker still running",
      cleanup: "keep" as const,
      createdAt: now - 30_000,
      startedAt: now - 30_000,
    };

    subagentRuns.set(parent.runId, parent);
    subagentRuns.set(child.runId, child);

    const result = handleSubagentsListAction({
      params: { cfg: {} },
      runs: [parent],
    } as never);

    expect(result.reply?.text).toContain("active (waiting on 1 child)");
    expect(result.reply?.text).not.toContain(
      "recent subagents (last 30m):\n-----\n1. orchestrate child workers",
    );
  });

  it("formats usage with io and prompt/cache breakdown from session store", () => {
    const run = {
      runId: "run-usage",
      childSessionKey: "agent:main:subagent:usage",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      cleanup: "keep" as const,
      createdAt: 1_000,
      startedAt: 1_000,
    };

    subagentRuns.set(run.runId, run);
    loadSessionStoreMock.mockReturnValue({
      "agent:main:subagent:usage": {
        sessionId: "child-session-usage",
        updatedAt: Date.now(),
        inputTokens: 12,
        outputTokens: 1000,
        totalTokens: 197000,
        model: "opencode/claude-opus-4-6",
      },
    });

    const result = handleSubagentsListAction({
      params: {
        cfg: {
          session: { store: "/tmp/sessions-{agentId}.json" },
        },
      },
      runs: [run],
    } as never);

    expect(resolveStorePathMock).toHaveBeenCalled();
    expect(loadSessionStoreMock).toHaveBeenCalledWith("/tmp/test-sessions.json");
    expect(result.reply?.text).toMatch(/tokens 1(\.0)?k \(in 12 \/ out 1(\.0)?k\)/);
    expect(result.reply?.text).toContain("prompt/cache 197k");
    expect(result.reply?.text).not.toContain("1k io");
  });
});
