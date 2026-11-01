import { expect, it, type Mock } from "vitest";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import { expectRespondOk } from "./agents-mutate.test-support.js";

type AgentDeletionAuthorityHarness = {
  mocks: {
    cronRemoveAgentJobsTransactional: Mock<
      (agentId: string, commit: () => Promise<unknown>) => Promise<unknown>
    >;
    withAgentExecApprovalsRemoved: Mock<
      (agentId: string, commit: () => Promise<unknown>) => Promise<unknown>
    >;
    writeConfigFile: Mock<(nextConfig?: unknown, writeOptions?: unknown) => Promise<void>>;
    unregisterResolvedAgentDir: Mock<(params: { agentId: string; agentDir: string }) => boolean>;
    closeOpenClawAgentDatabaseByPath: Mock<
      (pathname?: string, expectedAgentId?: string) => boolean
    >;
    assertAgentDeletionCurrentFinal: Mock<() => void>;
    assertAgentDeletionCurrentAsync: Mock<() => Promise<void>>;
    assertAgentDeletionCurrent: Mock;
    deleteWorkspaceState: Mock;
    beginAgentDeletionFinish: Mock;
  };
  call: (method: "agents.delete", params: Record<string, unknown>) => Promise<Mock>;
};

export function registerAgentDeletionAuthorityTests({
  mocks,
  call,
}: AgentDeletionAuthorityHarness): void {
  it("removes only the deleted agent's authority before committing its roster removal", async () => {
    const memoryOwner = memorySessionActorOwners.get({
      agentId: "test-agent",
      path: "/agents/test-agent/incognito-openclaw-agent.sqlite",
    });
    const survivor = memorySessionActorOwners.get({
      agentId: "other-agent",
      path: "/agents/other-agent/incognito-openclaw-agent.sqlite",
    });
    const authority = { assertCurrent() {}, authorize() {} };
    const sessionKey = "agent:test-agent:dashboard:incognito-deletion";
    const actor = await memoryOwner.acquire(
      { sessionKey, database: memoryOwner.identity },
      { assertCurrent() {}, assertReadable() {} },
    );
    const created = await actor.storage!.mutate(
      {
        type: "session.entry.create",
        input: { entry: { sessionId: "deleted-private-session", updatedAt: 1, incognito: true } },
      },
      authority,
    );
    expect(created.kind).toBe("committed");
    const cronJobs = [
      { id: "deleted-job", agentId: "test-agent" },
      { id: "other-job", agentId: "other-agent" },
    ];
    const approvals = new Set(["test-agent", "other-agent"]);
    const events: string[] = [];
    mocks.cronRemoveAgentJobsTransactional.mockImplementation(
      async (agentId: string, commit: () => Promise<unknown>) => {
        const snapshot = structuredClone(cronJobs);
        cronJobs.splice(0, cronJobs.length, ...cronJobs.filter((job) => job.agentId !== agentId));
        events.push("cron");
        try {
          return await commit();
        } catch (error) {
          cronJobs.splice(0, cronJobs.length, ...snapshot);
          throw error;
        }
      },
    );
    mocks.withAgentExecApprovalsRemoved.mockImplementation(
      async (agentId: string, commit: () => Promise<unknown>) => {
        const existed = approvals.delete(agentId);
        events.push("approvals");
        try {
          return await commit();
        } catch (error) {
          if (existed) {
            approvals.add(agentId);
          }
          throw error;
        }
      },
    );
    mocks.writeConfigFile.mockImplementationOnce(async () => {
      expect(memorySessionActorOwners.read(memoryOwner)).toBeUndefined();
      expect(memorySessionActorOwners.read(survivor)).toBe(survivor);
      expect(() => actor.snapshot(authority)).toThrow("closed");
      events.push("config");
    });
    mocks.unregisterResolvedAgentDir.mockImplementationOnce(() => {
      events.push("directory");
      return true;
    });
    mocks.closeOpenClawAgentDatabaseByPath.mockImplementation(() => {
      events.push("database");
      return true;
    });

    const respond = await call("agents.delete", { agentId: "test-agent" });

    const result = expectRespondOk(respond, {
      ok: true,
      agentId: "test-agent",
      removedBindings: 2,
      failed: [],
    });
    expect(result).not.toHaveProperty("purgeFailed");
    expect(result.removed).toEqual(
      expect.arrayContaining([
        { path: "/workspace/test-agent", method: "trash" },
        { path: "/agents/test-agent", method: "trash" },
        { path: "/transcripts/test-agent", method: "trash" },
      ]),
    );
    expect(mocks.writeConfigFile).toHaveBeenCalledWith(expect.anything(), {
      allowConfigSizeDrop: true,
      assertConfigPathForWrite: mocks.assertAgentDeletionCurrentFinal,
      beforeCommit: mocks.assertAgentDeletionCurrentAsync,
      allowedAgentRosterRemovals: ["test-agent"],
    });
    expect(mocks.deleteWorkspaceState).toHaveBeenCalledWith(
      { workspaceDir: "/workspace/test-agent" },
      {
        deletion: expect.objectContaining({ assertCurrentHost: mocks.assertAgentDeletionCurrent }),
      },
    );
    expect(cronJobs).toEqual([{ id: "other-job", agentId: "other-agent" }]);
    expect(approvals).toEqual(new Set(["other-agent"]));
    expect(mocks.cronRemoveAgentJobsTransactional).toHaveBeenCalledWith(
      "test-agent",
      expect.any(Function),
    );
    expect(mocks.withAgentExecApprovalsRemoved).toHaveBeenCalledWith(
      "test-agent",
      expect.any(Function),
      expect.objectContaining({ assertCurrentHost: mocks.assertAgentDeletionCurrent }),
    );
    expect(mocks.closeOpenClawAgentDatabaseByPath).toHaveBeenCalledWith(
      "/agents/test-agent/openclaw-agent.sqlite",
      "test-agent",
    );
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledWith({ unregisterDatabases: true });
    expect(mocks.unregisterResolvedAgentDir).toHaveBeenCalledWith({
      agentId: "test-agent",
      agentDir: "/agents/test-agent",
    });
    expect(events).toEqual(["database", "cron", "approvals", "config", "directory"]);
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
    await actor.release();
  });
}
