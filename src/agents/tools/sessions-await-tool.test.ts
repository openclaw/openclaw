import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
const getSubagentRunByChildSessionKeyMock = vi.fn();
const captureSubagentCompletionReplyMock = vi.fn();
const setSuppressAutoAnnounceMock = vi.fn();
const clearSuppressAutoAnnounceMock = vi.fn();

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
    requesterSessionKey: "agent:main:main",
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
    await loadFreshModules();
  });

  it("rejects empty sessionKeys array", async () => {
    const tool = createSessionsAwaitTool();
    const result = await tool.execute("call-1", { sessionKeys: [] });
    expect(result.details).toMatchObject({
      status: "error",
      error: expect.stringContaining("non-empty"),
    });
  });

  it("returns not_found for unknown session keys", async () => {
    const tool = createSessionsAwaitTool();
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

  it("returns immediately for already-completed runs", async () => {
    const completedRun = makeRun({
      runId: "run-done",
      childSessionKey: "agent:main:subagent:done",
      endedAt: Date.now(),
      outcome: { status: "ok" },
    });
    getSubagentRunByChildSessionKeyMock.mockReturnValue(completedRun);
    captureSubagentCompletionReplyMock.mockResolvedValue("Task completed successfully");

    const tool = createSessionsAwaitTool();
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

    const tool = createSessionsAwaitTool();
    await tool.execute("call-sup", {
      sessionKeys: ["agent:main:subagent:uuid1"],
    });

    expect(setSuppressAutoAnnounceMock).toHaveBeenCalledWith("run-x");
  });
});
