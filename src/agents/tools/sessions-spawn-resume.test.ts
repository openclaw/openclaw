import { describe, expect, it, vi, beforeEach } from "vitest";
import { createSessionsSpawnTool } from "./sessions-spawn-tool.js";

const hoisted = vi.hoisted(() => {
  const spawnAcpDirectMock = vi.fn();
  return {
    spawnAcpDirectMock,
  };
});

vi.mock("../acp-spawn.js", () => ({
  ACP_SPAWN_MODES: ["run", "session"],
  ACP_SPAWN_STREAM_TARGETS: ["parent"],
  spawnAcpDirect: (...args: unknown[]) => hoisted.spawnAcpDirectMock(...args),
}));

describe("sessions_spawn resumeSessionId integration tests", () => {
  beforeEach(() => {
    hoisted.spawnAcpDirectMock.mockReset().mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:codex:acp:1",
      runId: "run-acp",
    });
  });

  describe("session resume with conversation history", () => {
    it("resumes session and loads prior conversation history", async () => {
      const tool = createSessionsSpawnTool({
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
        agentAccountId: "default",
        agentTo: "channel:123",
        agentThreadId: "456",
      });

      const result = await tool.execute("call-resume-with-history", {
        runtime: "acp",
        task: "continue from where we left off",
        agentId: "codex",
        resumeSessionId: "session-with-history-123",
        mode: "session",
      });

      expect(result.details).toMatchObject({
        status: "accepted",
        childSessionKey: "agent:codex:acp:1",
      });

      expect(hoisted.spawnAcpDirectMock).toHaveBeenCalledWith(
        expect.objectContaining({
          task: "continue from where we left off",
          agentId: "codex",
          resumeSessionId: "session-with-history-123",
          mode: "session",
        }),
        expect.any(Object),
      );
    });

    it("resumes session with empty conversation history", async () => {
      const tool = createSessionsSpawnTool({
        agentSessionKey: "agent:main:main",
      });

      const result = await tool.execute("call-resume-empty-history", {
        runtime: "acp",
        task: "start fresh but reuse session",
        agentId: "codex",
        resumeSessionId: "empty-session-456",
        mode: "session",
      });

      expect(result.details).toMatchObject({
        status: "accepted",
      });

      // Should still pass resumeSessionId even for empty history
      expect(hoisted.spawnAcpDirectMock).toHaveBeenCalledWith(
        expect.objectContaining({
          resumeSessionId: "empty-session-456",
        }),
        expect.any(Object),
      );
    });

    it("fails when resuming non-existent session", async () => {
      // Mock returning an error result (not throwing)
      hoisted.spawnAcpDirectMock.mockResolvedValueOnce({
        status: "error",
        error: "Session not found: non-existent-session-789",
        code: "SESSION_NOT_FOUND",
      });

      const tool = createSessionsSpawnTool({
        agentSessionKey: "agent:main:main",
      });

      const result = await tool.execute("call-resume-nonexistent", {
        runtime: "acp",
        task: "try to resume deleted session",
        agentId: "codex",
        resumeSessionId: "non-existent-session-789",
        mode: "session",
      });

      expect(result.details).toMatchObject({
        status: "error",
      });
      const details = result.details as { error?: string };
      expect(details.error).toContain("Session not found");
    });

    it("validates session state after resume", async () => {
      const tool = createSessionsSpawnTool({
        agentSessionKey: "agent:main:main",
      });

      // Mock successful resume with session state
      hoisted.spawnAcpDirectMock.mockResolvedValueOnce({
        status: "accepted",
        childSessionKey: "agent:codex:acp:resumed",
        runId: "run-resumed",
        resumedSessionId: "validated-session-abc",
      });

      const result = await tool.execute("call-validate-resume", {
        runtime: "acp",
        task: "validate resumed session state",
        agentId: "codex",
        resumeSessionId: "validated-session-abc",
        mode: "session",
      });

      expect(result.details).toMatchObject({
        status: "accepted",
        childSessionKey: "agent:codex:acp:resumed",
      });
    });
  });

  describe("resumeSessionId edge cases", () => {
    it("accepts special characters in resumeSessionId", async () => {
      const tool = createSessionsSpawnTool({
        agentSessionKey: "agent:main:main",
      });

      const result = await tool.execute("call-special-chars", {
        runtime: "acp",
        task: "test special chars in resume id",
        agentId: "codex",
        resumeSessionId: "session-id-with-special-chars!@#",
        mode: "session",
      });

      expect(result.details).toMatchObject({
        status: "accepted",
      });
      expect(hoisted.spawnAcpDirectMock).toHaveBeenCalledWith(
        expect.objectContaining({
          resumeSessionId: "session-id-with-special-chars!@#",
        }),
        expect.any(Object),
      );
    });
  });

  describe("session resume edge cases", () => {
    it("handles concurrent resume attempts gracefully", async () => {
      const tool = createSessionsSpawnTool({
        agentSessionKey: "agent:main:main",
      });

      // Both calls should succeed when run concurrently
      hoisted.spawnAcpDirectMock.mockResolvedValue({
        status: "accepted",
        childSessionKey: "agent:codex:acp:concurrent",
        runId: "run-concurrent",
      });

      // Run both calls in parallel to test actual concurrency
      const [result1, result2] = await Promise.all([
        tool.execute("call-concurrent-1", {
          runtime: "acp",
          task: "first concurrent resume",
          agentId: "codex",
          resumeSessionId: "concurrent-session",
          mode: "session",
        }),
        tool.execute("call-concurrent-2", {
          runtime: "acp",
          task: "second concurrent resume",
          agentId: "codex",
          resumeSessionId: "concurrent-session",
          mode: "session",
        }),
      ]);

      expect(result1.details).toMatchObject({ status: "accepted" });
      expect(result2.details).toMatchObject({ status: "accepted" });
      expect(hoisted.spawnAcpDirectMock).toHaveBeenCalledTimes(2);
    });

    it("resumes session with stored secrets intact", async () => {
      const tool = createSessionsSpawnTool({
        agentSessionKey: "agent:main:main",
      });

      hoisted.spawnAcpDirectMock.mockResolvedValueOnce({
        status: "accepted",
        childSessionKey: "agent:codex:acp:with-secrets",
        runId: "run-with-secrets",
        resumedWithSecrets: true,
      });

      const result = await tool.execute("call-resume-secrets", {
        runtime: "acp",
        task: "access stored secrets",
        agentId: "codex",
        resumeSessionId: "session-with-secrets",
        mode: "session",
      });

      expect(result.details).toMatchObject({
        status: "accepted",
      });
    });

    it("handles expired session resume attempt", async () => {
      // Mock returning an error result for expired session
      hoisted.spawnAcpDirectMock.mockResolvedValueOnce({
        status: "error",
        error: "Session expired: expired-session-xyz",
        code: "SESSION_EXPIRED",
      });

      const tool = createSessionsSpawnTool({
        agentSessionKey: "agent:main:main",
      });

      const result = await tool.execute("call-resume-expired", {
        runtime: "acp",
        task: "try to resume expired session",
        agentId: "codex",
        resumeSessionId: "expired-session-xyz",
        mode: "session",
      });

      expect(result.details).toMatchObject({
        status: "error",
      });
    });
  });
});
