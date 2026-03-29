import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
const getSubagentRunByChildSessionKeyMock = vi.fn();
const captureSubagentCompletionReplyMock = vi.fn();
const setSuppressAutoAnnounceMock = vi.fn();
const clearSuppressAutoAnnounceMock = vi.fn();
const loadConfigMock = vi.fn();
const REQUESTER_SESSION_KEY = "agent:main:main";

let createSessionsAwaitTool: typeof import("./sessions-await-tool.js").createSessionsAwaitTool;

async function loadFreshModules() {
  vi.resetModules();
  vi.doMock("../../gateway/call.js", () => ({
    callGateway: (...args: unknown[]) => callGatewayMock(...args),
  }));
  vi.doMock("../../config/config.js", () => ({
    loadConfig: (...args: unknown[]) => loadConfigMock(...args),
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
    loadConfigMock.mockReset().mockReturnValue({
      session: { mainKey: "main", scope: "per-sender" },
    });
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

  it("accepts controller session ownership when requester session differs", async () => {
    const ownedByControllerRun = makeRun({
      runId: "run-controller-owner",
      childSessionKey: "agent:main:subagent:controller-owner",
      requesterSessionKey: "agent:main:original-requester",
      controllerSessionKey: REQUESTER_SESSION_KEY,
      endedAt: Date.now(),
      outcome: { status: "ok" },
    });
    getSubagentRunByChildSessionKeyMock.mockImplementation((key: string) =>
      key === "agent:main:subagent:controller-owner" ? ownedByControllerRun : null,
    );
    captureSubagentCompletionReplyMock.mockResolvedValue("controller-owned done");

    const tool = createSessionsAwaitTool({ agentSessionKey: REQUESTER_SESSION_KEY });
    const result = await tool.execute("call-controller-owner", {
      sessionKeys: ["agent:main:subagent:controller-owner"],
    });

    const details = result.details as { status: string; results: Array<Record<string, unknown>> };
    expect(details.status).toBe("ok");
    expect(details.results).toEqual([
      {
        sessionKey: "agent:main:subagent:controller-owner",
        status: "completed",
        runId: "run-controller-owner",
        reply: "controller-owned done",
      },
    ]);
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("normalizes requester session key aliases before owner checks", async () => {
    loadConfigMock.mockReturnValue({
      session: { mainKey: "main", scope: "global" },
    });
    await loadFreshModules();
    const ownedRun = makeRun({
      runId: "run-global-owner",
      childSessionKey: "agent:main:subagent:global-owner",
      requesterSessionKey: "global",
      requesterDisplayKey: "main",
      endedAt: Date.now(),
      outcome: { status: "ok" },
    });
    getSubagentRunByChildSessionKeyMock.mockImplementation((key: string) =>
      key === "agent:main:subagent:global-owner" ? ownedRun : null,
    );
    captureSubagentCompletionReplyMock.mockResolvedValue("done");

    const tool = createSessionsAwaitTool({ agentSessionKey: "main" });
    const result = await tool.execute("call-global-owner", {
      sessionKeys: ["agent:main:subagent:global-owner"],
    });

    const details = result.details as { status: string; results: Array<Record<string, unknown>> };
    expect(details.status).toBe("ok");
    expect(details.results).toEqual([
      {
        sessionKey: "agent:main:subagent:global-owner",
        status: "completed",
        runId: "run-global-owner",
        reply: "done",
      },
    ]);
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

  it("deletes cleanup=delete sessions after awaited reply capture", async () => {
    const completedRun = makeRun({
      runId: "run-delete-after-capture",
      childSessionKey: "agent:main:subagent:delete-after-capture",
      cleanup: "delete",
      endedAt: Date.now(),
      outcome: { status: "ok" },
    });
    getSubagentRunByChildSessionKeyMock.mockImplementation((key: string) =>
      key === "agent:main:subagent:delete-after-capture" ? completedRun : null,
    );

    let captured = false;
    captureSubagentCompletionReplyMock.mockImplementation(async () => {
      captured = true;
      return "captured output";
    });
    callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "sessions.delete") {
        expect(captured).toBe(true);
        return { ok: true };
      }
      return { status: "ok" };
    });

    const tool = createSessionsAwaitTool({ agentSessionKey: REQUESTER_SESSION_KEY });
    const result = await tool.execute("call-delete-after-capture", {
      sessionKeys: ["agent:main:subagent:delete-after-capture"],
    });

    const details = result.details as { status: string; results: Array<Record<string, unknown>> };
    expect(details.status).toBe("ok");
    expect(details.results[0]).toMatchObject({
      sessionKey: "agent:main:subagent:delete-after-capture",
      status: "completed",
      runId: "run-delete-after-capture",
      reply: "captured output",
    });
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.delete",
        params: expect.objectContaining({
          key: "agent:main:subagent:delete-after-capture",
          deleteTranscript: true,
          emitLifecycleHooks: false,
        }),
        timeoutMs: 10_000,
      }),
    );
  });

  it("defers cleanup=delete session removal when reply capture fails", async () => {
    const completedRun = makeRun({
      runId: "run-delete-capture-fail",
      childSessionKey: "agent:main:subagent:delete-capture-fail",
      cleanup: "delete",
      endedAt: Date.now(),
      outcome: { status: "ok" },
    });
    getSubagentRunByChildSessionKeyMock.mockImplementation((key: string) =>
      key === "agent:main:subagent:delete-capture-fail" ? completedRun : null,
    );
    captureSubagentCompletionReplyMock.mockRejectedValue(new Error("history unavailable"));

    const tool = createSessionsAwaitTool({ agentSessionKey: REQUESTER_SESSION_KEY });
    const result = await tool.execute("call-delete-capture-fail", {
      sessionKeys: ["agent:main:subagent:delete-capture-fail"],
    });

    const details = result.details as { status: string; results: Array<Record<string, unknown>> };
    expect(details.status).toBe("ok");
    expect(details.results[0]).toMatchObject({
      sessionKey: "agent:main:subagent:delete-capture-fail",
      status: "completed",
      runId: "run-delete-capture-fail",
      error: expect.stringContaining("failed to capture sub-agent completion reply"),
    });
    expect(callGatewayMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.delete",
      }),
    );
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

  it("classifies ended timeout outcomes as timeout", async () => {
    const timedOutRun = makeRun({
      runId: "run-timeout-ended",
      childSessionKey: "agent:main:subagent:timeout-ended",
      endedAt: Date.now(),
      outcome: { status: "timeout" },
    });
    getSubagentRunByChildSessionKeyMock.mockImplementation((key: string) =>
      key === "agent:main:subagent:timeout-ended" ? timedOutRun : null,
    );

    const tool = createSessionsAwaitTool({ agentSessionKey: REQUESTER_SESSION_KEY });
    const result = await tool.execute("call-ended-timeout", {
      sessionKeys: ["agent:main:subagent:timeout-ended"],
    });

    const details = result.details as { status: string; results: Array<Record<string, unknown>> };
    expect(details.status).toBe("partial");
    expect(details.results).toHaveLength(1);
    expect(details.results[0]).toMatchObject({
      sessionKey: "agent:main:subagent:timeout-ended",
      status: "timeout",
      runId: "run-timeout-ended",
      error: "Sub-agent timed out",
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

    const tool = createSessionsAwaitTool({ agentSessionKey: REQUESTER_SESSION_KEY });
    await tool.execute("call-sup", {
      sessionKeys: ["agent:main:subagent:uuid1"],
    });

    expect(setSuppressAutoAnnounceMock).toHaveBeenCalledWith("run-x");
  });

  it("deduplicates session keys before waiting and reporting results", async () => {
    const sessionKey = "agent:main:subagent:dup";
    const activeRun = makeRun({
      runId: "run-dup",
      childSessionKey: sessionKey,
    });
    getSubagentRunByChildSessionKeyMock.mockImplementation((key: string) =>
      key === sessionKey ? activeRun : null,
    );
    callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        (activeRun as Record<string, unknown>).endedAt = Date.now();
        (activeRun as Record<string, unknown>).outcome = { status: "ok" };
        return { status: "ok" };
      }
      return { ok: true };
    });
    captureSubagentCompletionReplyMock.mockResolvedValue("deduped");

    const tool = createSessionsAwaitTool({ agentSessionKey: REQUESTER_SESSION_KEY });
    const result = await tool.execute("call-dedupe", {
      sessionKeys: [sessionKey, sessionKey, ` ${sessionKey} `],
    });

    const details = result.details as { status: string; results: Array<Record<string, unknown>> };
    expect(details.status).toBe("ok");
    expect(details.results).toHaveLength(1);
    expect(details.results[0]).toMatchObject({
      sessionKey,
      status: "completed",
      runId: "run-dup",
      reply: "deduped",
    });
    expect(setSuppressAutoAnnounceMock).toHaveBeenCalledTimes(1);
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "agent.wait",
        params: expect.objectContaining({
          runId: "run-dup",
        }),
      }),
    );
  });

  it("preserves waited results when run is evicted after wait", async () => {
    const evictedRun = makeRun({ runId: "run-evicted" });
    let lookupCount = 0;
    getSubagentRunByChildSessionKeyMock.mockImplementation((key: string) => {
      if (key !== "agent:main:subagent:uuid1") {
        return null;
      }
      lookupCount += 1;
      return lookupCount === 1 ? evictedRun : null;
    });
    callGatewayMock.mockResolvedValue({ status: "ok" });
    captureSubagentCompletionReplyMock.mockResolvedValue("done");

    const tool = createSessionsAwaitTool({ agentSessionKey: REQUESTER_SESSION_KEY });
    const result = await tool.execute("call-evicted", {
      sessionKeys: ["agent:main:subagent:uuid1"],
    });

    const details = result.details as { status: string; results: Array<Record<string, unknown>> };
    expect(details.status).toBe("ok");
    expect(details.results).toHaveLength(1);
    expect(details.results[0]).toMatchObject({
      sessionKey: "agent:main:subagent:uuid1",
      status: "completed",
      runId: "run-evicted",
      reply: "done",
    });
  });

  it("pins cleanup/delete behavior to the originally awaited run id", async () => {
    const childSessionKey = "agent:main:subagent:reused";
    const initialRun = makeRun({
      runId: "run-old",
      childSessionKey,
      cleanup: "delete",
    });
    const newerRun = makeRun({
      runId: "run-new",
      childSessionKey,
      cleanup: "delete",
      createdAt: Date.now() + 1_000,
    });
    let lookupCount = 0;
    getSubagentRunByChildSessionKeyMock.mockImplementation((key: string) => {
      if (key !== childSessionKey) {
        return null;
      }
      lookupCount += 1;
      return lookupCount === 1 ? initialRun : newerRun;
    });
    callGatewayMock.mockResolvedValue({ status: "ok" });
    captureSubagentCompletionReplyMock.mockResolvedValue("old run done");

    const tool = createSessionsAwaitTool({ agentSessionKey: REQUESTER_SESSION_KEY });
    const result = await tool.execute("call-reused-session-key", {
      sessionKeys: [childSessionKey],
    });

    const details = result.details as { status: string; results: Array<Record<string, unknown>> };
    expect(details.status).toBe("ok");
    expect(details.results).toHaveLength(1);
    expect(details.results[0]).toMatchObject({
      sessionKey: childSessionKey,
      status: "completed",
      runId: "run-old",
      reply: "old run done",
    });
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "agent.wait",
        params: expect.objectContaining({
          runId: "run-old",
        }),
      }),
    );
    expect(callGatewayMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.delete",
      }),
    );
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

  it("returns per-session capture error instead of throwing", async () => {
    const completedRun = makeRun({
      runId: "run-capture-fail",
      childSessionKey: "agent:main:subagent:capture-fail",
      endedAt: Date.now(),
      outcome: { status: "ok" },
    });
    getSubagentRunByChildSessionKeyMock.mockImplementation((key: string) =>
      key === "agent:main:subagent:capture-fail" ? completedRun : null,
    );
    captureSubagentCompletionReplyMock.mockRejectedValue(new Error("history unavailable"));

    const tool = createSessionsAwaitTool({ agentSessionKey: REQUESTER_SESSION_KEY });
    const result = await tool.execute("call-capture-fail", {
      sessionKeys: ["agent:main:subagent:capture-fail"],
    });

    const details = result.details as { status: string; results: Array<Record<string, unknown>> };
    expect(details.status).toBe("ok");
    expect(details.results).toHaveLength(1);
    expect(details.results[0]).toMatchObject({
      sessionKey: "agent:main:subagent:capture-fail",
      status: "completed",
      runId: "run-capture-fail",
      error: expect.stringContaining("failed to capture sub-agent completion reply"),
    });
  });
});
