import { expect, it, type Mock } from "vitest";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import { expectRespondOk } from "./agents-mutate.test-support.js";

type CommitAgentMutation = (agentId: string, commit: () => Promise<unknown>) => Promise<unknown>;

type AgentDeletionAuthorityHarness = {
  mocks: {
    cronRemoveAgentJobsTransactional: Mock<CommitAgentMutation>;
    withAgentExecApprovalsRemoved: Mock<CommitAgentMutation>;
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
    const owner = (agentId: string) =>
      memorySessionActorOwners.get({
        agentId,
        path: `/agents/${agentId}/incognito-openclaw-agent.sqlite`,
      });
    const memoryOwner = owner("test-agent");
    const survivor = owner("other-agent");
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
    mocks.cronRemoveAgentJobsTransactional.mockImplementation(async (agentId, commit) => {
      cronJobs.splice(0, cronJobs.length, ...cronJobs.filter((job) => job.agentId !== agentId));
      events.push("cron");
      return await commit();
    });
    mocks.withAgentExecApprovalsRemoved.mockImplementation(async (agentId, commit) => {
      approvals.delete(agentId);
      events.push("approvals");
      return await commit();
    });
    mocks.writeConfigFile.mockImplementationOnce(async () => {
      expect(memorySessionActorOwners.read(memoryOwner)).toBeUndefined();
      expect(memorySessionActorOwners.read(survivor)).toBe(survivor);
      expect(() => actor.snapshot(authority)).toThrow("closed");
      events.push("config");
    });
    const record = (event: string) => () => {
      events.push(event);
      return true;
    };
    mocks.unregisterResolvedAgentDir.mockImplementationOnce(record("directory"));
    mocks.closeOpenClawAgentDatabaseByPath.mockImplementation(record("database"));

    const result = expectRespondOk(await call("agents.delete", { agentId: "test-agent" }), {
      ok: true,
      agentId: "test-agent",
      removedBindings: 2,
      failed: [],
      removed: expect.arrayContaining([
        { path: "/workspace/test-agent", method: "trash" },
        { path: "/agents/test-agent", method: "trash" },
        { path: "/transcripts/test-agent", method: "trash" },
      ]),
    });
    expect(result).not.toHaveProperty("purgeFailed");
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
    expect(mocks.withAgentExecApprovalsRemoved).toHaveBeenCalledWith(
      "test-agent",
      expect.any(Function),
      expect.objectContaining({ assertCurrentHost: mocks.assertAgentDeletionCurrent }),
    );
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledExactlyOnceWith({
      unregisterDatabases: true,
    });
    expect(events).toEqual(["database", "cron", "approvals", "config", "directory"]);
    await actor.release();
  });
}
