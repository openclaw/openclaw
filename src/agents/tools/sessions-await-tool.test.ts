import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
const getSubagentRunByChildSessionKeyMock = vi.fn();
const captureSubagentCompletionReplyMock = vi.fn();
const setSuppressAutoAnnounceMock = vi.fn();
const clearSuppressAutoAnnounceMock = vi.fn();
const REQUESTER_SESSION_KEY = "agent:main:main";

let createSessionsAwaitTool: typeof import("./sessions-await-tool.js").createSessionsAwaitTool;

async function loadFreshModules() {
  vi.resetModules();
  vi.doMock("../../gateway/call.js", () => ({
    callGateway: (...args: unknown[]) => callGatewayMock(...args),
  }));
  vi.doMock("../subagent-registry.js", () => ({
    getSubagentRunByChildSessionKey: (...args: unknown[]) =>
      getSubagentRunByChildSessionKeyMock(...args),
    setSuppressAutoAnnounce: (...args: unknown[]) => setSuppressAutoAnnounceMock(...args),
    clearSuppressAutoAnnounce: (...args: unknown[]) => clearSuppressAutoAnnounceMock(...args),
  }));
  vi.doMock("../subagent-announce.js", () => ({
    captureSubagentCompletionReply: (...args: unknown[]) =>
      captureSubagentCompletionReplyMock(...args),
  }));
  ({ createSessionsAwaitTool } = await import("./sessions-await-tool.js"));
}

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:uuid1",
    requesterSessionKey: REQUESTER_SESSION_KEY,
    requesterDisplayKey: "main",
    task: "test task",
    cleanup: "keep",
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("sessions_await tool", () => {
  beforeEach(async () => {
    callGatewayMock.mockReset().mockResolvedValue({ status: "ok" });
    getSubagentRunByChildSessionKeyMock.mockReset().mockReturnValue(null);
    captureSubagentCompletionReplyMock.mockReset().mockResolvedValue(undefined);
    setSuppressAutoAnnounceMock.mockReset().mockReturnValue(true);
    clearSuppressAutoAnnounceMock.mockReset();
    await loadFreshModules();
  });

  it("requires requester session context", async () => {
    const tool = createSessionsAwaitTool();
    const result = await tool.execute("call-no-ctx", {
      sessionKeys: ["agent:main:subagent:uuid1"],
    });
    expect(result.details).toMatchObject({
      status: "error",
      error: expect.stringContaining("active requester session"),
    });
  });

  it("rejects empty sessionKeys array", async () => {
    const tool = createSessionsAwaitTool({ agentSessionKey: REQUESTER_SESSION_KEY });
    const result = await tool.execute("call-1", { sessionKeys: [] });
    expect(result.details).toMatchObject({
      status: "error",
      error: expect.stringContaining("non-empty"),
    });
  });

  it("returns not_found for unknown session keys", async () => {
    const tool = createSessionsAwaitTool({ agentSessionKey: REQUESTER_SESSION_KEY });
    const result = await tool.execute("call-2", {
      sessionKeys: ["agent:main:subagent:unknown"],
    });

    const details = result.details as { status: string; results: Array<{ status: string }> };
    expect(details.status).toBe("error");
    expect(details.results).toHaveLength(1);
    expect(details.results[0]).toMatchObject({
      sessionKey: "agent:main:subagent:unknown",
      status: "not_found",
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("returns not_found for runs owned by another requester session", async () => {
    const foreignRun = makeRun({
      runId: "run-foreign",
      childSessionKey: "agent:main:subagent:foreign",
      requesterSessionKey: "agent:main:other-requester",
    });
    getSubagentRunByChildSessionKeyMock.mockImplementation((key: string) =>
      key === "agent:main:subagent:foreign" ? foreignRun : null,
    );

    const tool = createSessionsAwaitTool({ agentSessionKey: REQUESTER_SESSION_KEY });
    const result = await tool.execute("call-foreign", {
      sessionKeys: ["agent:main:subagent:foreign"],
    });

    const details = result.details as { status: string; results: Array<Record<string, unknown>> };
    expect(details.status).toBe("error");
    expect(details.results).toEqual([
      {
        sessionKey: "agent:main:subagent:foreign",
        status: "not_found",
        error: "No registered run found for this session key",
      },
    ]);
    expect(setSuppressAutoAnnounceMock).not.toHaveBeenCalled();
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("returns immediately for already-completed runs", async () => {
    const completedRun = makeRun({
      runId: "run-done",
      childSessionKey: "agent:main:subagent:done",
      endedAt: Date.now(),
      outcome: { status: "ok" },
    });
    getSubagentRunByChildSessionKeyMock.mockReturnValue(completedRun);
    captureSubagentCompletionReplyMock.mockResolvedValue("Task completed successfully");

    const tool = createSessionsAwaitTool({ agentSessionKey: REQUESTER_SESSION_KEY });
    const result = await tool.execute("call-3", {
      sessionKeys: ["agent:main:subagent:done"],
    });

    const details = result.details as { status: string; results: Array<Record<string, unknown>> };
    expect(details.status).toBe("ok");
    expect(details.results).toHaveLength(1);
    expect(details.results[0]).toMatchObject({
      sessionKey: "agent:main:subagent:done",
      status: "completed",
      runId: "run-done",
      reply: "Task completed successfully",
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("returns overall error when every subagent result is error", async () => {
    const failedA = makeRun({
      runId: "run-err-a",
      childSessionKey: "agent:main:subagent:err-a",
      endedAt: Date.now(),
      outcome: { status: "error", error: "A failed" },
    });
    const failedB = makeRun({
      runId: "run-err-b",
      childSessionKey: "agent:main:subagent:err-b",
      endedAt: Date.now(),
      outcome: { status: "error", error: "B failed" },
    });
    getSubagentRunByChildSessionKeyMock.mockImplementation((key: string) => {
      if (key === "agent:main:subagent:err-a") {
        return failedA;
      }
      if (key === "agent:main:subagent:err-b") {
        return failedB;
      }
      return null;
    });

    const tool = createSessionsAwaitTool({ agentSessionKey: REQUESTER_SESSION_KEY });
    const result = await tool.execute("call-all-error", {
      sessionKeys: ["agent:main:subagent:err-a", "agent:main:subagent:err-b"],
    });

    const details = result.details as { status: string; results: Array<Record<string, unknown>> };
    expect(details.status).toBe("error");
    expect(details.results).toHaveLength(2);
    expect(details.results.every((entry) => entry.status === "error")).toBe(true);
  });

  it("suppresses auto-announce for active runs before waiting", async () => {
    const activeRun = makeRun({ runId: "run-x" });
    getSubagentRunByChildSessionKeyMock.mockImplementation((key: string) =>
      key === "agent:main:subagent:uuid1" ? activeRun : null,
    );
    callGatewayMock.mockImplementation(async () => {
      (activeRun as Record<string, unknown>).endedAt = Date.now();
      (activeRun as Record<string, unknown>).outcome = { status: "ok" };
      return { status: "ok" };
    });
    captureSubagentCompletionReplyMock.mockResolvedValue("done");

    const tool = createSessionsAwaitTool({ agentSessionKey: REQUESTER_SESSION_KEY });
    await tool.execute("call-sup", {
      sessionKeys: ["agent:main:subagent:uuid1"],
    });

    expect(setSuppressAutoAnnounceMock).toHaveBeenCalledWith("run-x");
  });

  it("treats agent.wait transport failures as errors", async () => {
    const activeRun = makeRun({ runId: "run-transport-error" });
    getSubagentRunByChildSessionKeyMock.mockImplementation((key: string) =>
      key === "agent:main:subagent:uuid1" ? activeRun : null,
    );
    callGatewayMock.mockRejectedValue(new Error("gateway disconnected"));

    const tool = createSessionsAwaitTool({ agentSessionKey: REQUESTER_SESSION_KEY });
    const result = await tool.execute("call-transport-error", {
      sessionKeys: ["agent:main:subagent:uuid1"],
    });

    const details = result.details as { status: string; results: Array<Record<string, unknown>> };
    expect(details.status).toBe("error");
    expect(details.results).toHaveLength(1);
    expect(details.results[0]).toMatchObject({
      sessionKey: "agent:main:subagent:uuid1",
      status: "error",
      runId: "run-transport-error",
      error: "gateway disconnected",
    });
  });
});
