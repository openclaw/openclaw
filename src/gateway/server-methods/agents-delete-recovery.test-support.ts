import { expect, it, vi, type Mock } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { AgentDeletionAuthorityRollbackError } from "../../agents/agent-lifecycle-registry.js";
import {
  clearActiveEmbeddedRun,
  isEmbeddedAgentRunInProgress,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import {
  deletionJournal,
  expectRespondErrorContaining,
  expectRespondOk,
} from "./agents-mutate.test-support.js";

type AgentDeleteRecoveryHarness = {
  mocks: {
    loadConfigReturn: Record<string, unknown>;
    sharedAuthStoreOwnership: { location: "legacy-main" | "state-db" };
    findAgentEntryIndex: Mock<(list?: unknown, agentId?: string) => number>;
    readAgentDeletionJournal: Mock<() => Record<string, unknown> | undefined>;
    listPendingAgentDeletionJournals: Mock<() => Record<string, unknown>[]>;
    beginAgentDeletionRetire: Mock<() => void>;
    beginAgentDeletionFinish: unknown;
    beginAgentDeletionRollback: unknown;
    closeOpenClawAgentDatabaseByPath: unknown;
    movePathToTrash: unknown;
    readSessionEntrySummariesInWorker: unknown;
    logGatewayWarn: unknown;
    writeConfigFile: Mock<(nextConfig?: unknown, writeOptions?: unknown) => Promise<void>>;
    cronRemoveAgentJobsTransactional: Mock<
      (agentId: string, commit: () => Promise<unknown>) => Promise<unknown>
    >;
    withAgentExecApprovalsRemoved: Mock<
      (agentId: string, commit: () => Promise<unknown>) => Promise<unknown>
    >;
  };
  makeCall: (
    method: "agents.delete" | "agents.create",
    params: Record<string, unknown>,
  ) => { respond: Mock; promise: Promise<void> | void };
  call: (
    method: "agents.delete" | "agents.create",
    params: Record<string, unknown>,
  ) => Promise<Mock>;
  resume: () => Promise<void>;
  expectTrashedWithinParent: (pathname: string, declaredPath?: string) => void;
};

export function registerAgentDeleteDrainRecoveryTests(harness: AgentDeleteRecoveryHarness): void {
  const { mocks, makeCall, call, resume, expectTrashedWithinParent } = harness;
  it.for(["agent:test-agent:active", "global", undefined])(
    "drains an active %s run before retirement and permits recreation without a deletion retry",
    async (sessionKey, { signal }) => {
      const sessionId = "delete-active-session";
      const aborted = createDeferred();
      const settled = createDeferred();
      const abort = vi.fn(() => aborted.resolve());
      const handle = createEmbeddedRunHandle({ runId: "delete-active-run", abort });
      const foreign = createEmbeddedRunHandle({ runId: "other-active-run", abort: vi.fn() });
      setActiveEmbeddedRun(sessionId, handle, sessionKey, undefined, "test-agent");
      setActiveEmbeddedRun("other-session", foreign, "global", undefined, "main");
      const owner = settled.promise.then(() =>
        clearActiveEmbeddedRun(sessionId, handle, sessionKey),
      );
      const deletion = makeCall("agents.delete", { agentId: "test-agent" });
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            aborted.promise,
            Promise.resolve(deletion.promise),
            "Deletion completed without aborting its active run",
          ),
          signal,
        );
        expect(abort).toHaveBeenCalledOnce();
        expect(mocks.beginAgentDeletionRetire).not.toHaveBeenCalled();
        expect(mocks.closeOpenClawAgentDatabaseByPath).not.toHaveBeenCalled();
        expect(mocks.movePathToTrash).not.toHaveBeenCalled();
        expect(deletion.respond).not.toHaveBeenCalled();
        expect(foreign.abort).not.toHaveBeenCalled();

        settled.resolve();
        await owner;
        await deletion.promise;
        const result = expectRespondOk(deletion.respond, { ok: true, failed: [] });
        expect(result.removed).toEqual(
          expect.arrayContaining([
            { path: "/workspace/test-agent", method: "trash" },
            { path: "/agents/test-agent", method: "trash" },
            { path: "/transcripts/test-agent", method: "trash" },
          ]),
        );
        expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
        expect(isEmbeddedAgentRunInProgress(sessionId)).toBe(false);
        expect(isEmbeddedAgentRunInProgress("other-session")).toBe(true);
        mocks.loadConfigReturn = { agents: { entries: { main: {} } } };
        mocks.findAgentEntryIndex.mockReturnValue(-1);
        mocks.readAgentDeletionJournal.mockReturnValue(deletionJournal({ cleanupCompleted: true }));
        const recreated = await call("agents.create", { name: "Test Agent" });
        expectRespondOk(recreated, { ok: true, agentId: "test-agent" });
      } finally {
        settled.resolve();
        await owner;
        clearActiveEmbeddedRun("other-session", foreign, "global");
        await deletion.promise;
      }
    },
  );

  it.each(["draining", "legacy"] as const)(
    "automatically resumes a %s deletion journal after restart",
    async (phase) => {
      const journal: Record<string, unknown> = { ...deletionJournal({ phase: "draining" }) };
      if (phase === "legacy") {
        delete journal.phase;
      }
      mocks.readAgentDeletionJournal.mockReturnValue(journal);
      mocks.listPendingAgentDeletionJournals.mockReturnValue([journal]);
      await resume();
      expect(mocks.logGatewayWarn).not.toHaveBeenCalled();
      expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
      expectTrashedWithinParent("/journal/agent/openclaw-agent.sqlite");
      if (phase === "draining") {
        expect(mocks.beginAgentDeletionRetire).toHaveBeenCalledOnce();
      } else {
        expect(mocks.readSessionEntrySummariesInWorker).not.toHaveBeenCalled();
      }
    },
  );

  it("does not replay a deletion journal after another operation replaces it", async () => {
    mocks.listPendingAgentDeletionJournals.mockReturnValue([
      { ...deletionJournal({ phase: "draining", operationId: "previous-deletion" }) },
    ]);
    mocks.readAgentDeletionJournal.mockReturnValue({
      ...deletionJournal({ phase: "draining", operationId: "replacement-deletion" }),
    });
    await resume();
    expect(mocks.logGatewayWarn).toHaveBeenCalledOnce();
    expect(mocks.beginAgentDeletionRetire).not.toHaveBeenCalled();
    expect(mocks.beginAgentDeletionFinish).not.toHaveBeenCalled();
    expect(mocks.closeOpenClawAgentDatabaseByPath).not.toHaveBeenCalled();
    expect(mocks.movePathToTrash).not.toHaveBeenCalled();
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });
}

export function registerAgentDeleteRollbackTests(harness: AgentDeleteRecoveryHarness): void {
  const { mocks, makeCall, call } = harness;
  it("rolls back a fresh deletion when draining leaves it as the only configured agent", async () => {
    mocks.sharedAuthStoreOwnership = { location: "state-db" };
    mocks.beginAgentDeletionRetire.mockImplementationOnce(() => {
      mocks.loadConfigReturn = {
        agents: { entries: { "test-agent": { workspace: "/workspace/test-agent" } } },
      };
    });

    const respond = await call("agents.delete", { agentId: "test-agent" });

    expectRespondErrorContaining(respond, "not found");
    expect(mocks.beginAgentDeletionRetire).toHaveBeenCalledOnce();
    expect(mocks.beginAgentDeletionRollback).toHaveBeenCalledOnce();
    expect(mocks.closeOpenClawAgentDatabaseByPath).not.toHaveBeenCalled();
    expect(mocks.movePathToTrash).not.toHaveBeenCalled();
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    expect(mocks.beginAgentDeletionFinish).not.toHaveBeenCalled();
  });

  it("rolls cron back and keeps the roster when authority cleanup fails", async () => {
    const cronJobs = [
      { id: "deleted-job", agentId: "test-agent" },
      { id: "other-job", agentId: "other-agent" },
    ];
    mocks.cronRemoveAgentJobsTransactional.mockImplementation(
      async (agentId: string, commit: () => Promise<unknown>) => {
        const snapshot = structuredClone(cronJobs);
        cronJobs.splice(0, cronJobs.length, ...cronJobs.filter((job) => job.agentId !== agentId));
        try {
          return await commit();
        } catch (error) {
          cronJobs.splice(0, cronJobs.length, ...snapshot);
          throw error;
        }
      },
    );
    mocks.withAgentExecApprovalsRemoved.mockRejectedValueOnce(new Error("approvals busy"));

    const { promise } = makeCall("agents.delete", { agentId: "test-agent" });

    await expect(promise).rejects.toThrow("approvals busy");
    expect(cronJobs).toEqual([
      { id: "deleted-job", agentId: "test-agent" },
      { id: "other-job", agentId: "other-agent" },
    ]);
    expect(mocks.beginAgentDeletionRollback).toHaveBeenCalledOnce();
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    expect(mocks.closeOpenClawAgentDatabaseByPath).toHaveBeenCalledTimes(2);
    expect(mocks.movePathToTrash).not.toHaveBeenCalled();
  });

  it("keeps a recovered deletion journal fenced when retry cleanup fails", async () => {
    mocks.readAgentDeletionJournal.mockReturnValue(deletionJournal());
    mocks.withAgentExecApprovalsRemoved.mockRejectedValueOnce(new Error("approvals busy"));

    const { promise } = makeCall("agents.delete", { agentId: "test-agent" });

    await expect(promise).rejects.toThrow("approvals busy");
    expect(mocks.beginAgentDeletionRollback).not.toHaveBeenCalled();
    expect(mocks.beginAgentDeletionFinish).not.toHaveBeenCalled();
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("keeps a new deletion fenced when authority rollback fails", async () => {
    mocks.withAgentExecApprovalsRemoved.mockRejectedValueOnce(
      new AgentDeletionAuthorityRollbackError(
        [new Error("config failed"), new Error("approval restore failed")],
        "approval rollback failed",
      ),
    );

    const { promise } = makeCall("agents.delete", { agentId: "test-agent" });

    await expect(promise).rejects.toThrow("approval rollback failed");
    expect(mocks.beginAgentDeletionRollback).not.toHaveBeenCalled();
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("keeps deletion fenced when config persistence succeeds before reporting failure", async () => {
    mocks.writeConfigFile.mockImplementationOnce(async (nextConfig?: unknown) => {
      if (!nextConfig || typeof nextConfig !== "object") {
        throw new Error("expected config object");
      }
      mocks.loadConfigReturn = nextConfig as Record<string, unknown>;
      throw new Error("post-write refresh failed");
    });

    const { promise } = makeCall("agents.delete", { agentId: "test-agent" });

    await expect(promise).rejects.toThrow("post-write refresh failed");
    expect(mocks.beginAgentDeletionRollback).not.toHaveBeenCalled();
    expect(mocks.closeOpenClawAgentDatabaseByPath).toHaveBeenCalled();
    expect(mocks.movePathToTrash).not.toHaveBeenCalled();
  });
}
