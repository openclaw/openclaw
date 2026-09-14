import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
  resolveAdmittedRunWorkerAdmission,
} from "../agents/admitted-run-context.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  claimHeartbeatContextForUserRun,
  claimHeartbeatOutcomeForRun,
  persistHeartbeatOutcome,
} from "./heartbeat-outcome-store.js";
import { requireNodeSqlite } from "./node-sqlite.js";

const tempDirs = createTempDirTracker();

async function createEnv(): Promise<NodeJS.ProcessEnv> {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-heartbeat-outcome-") };
  await upsertSessionEntryCore(
    { agentId: "main", env, sessionKey: "agent:main:main" },
    { sessionId: "heartbeat-outcome-test", updatedAt: 1 },
  );
  return env;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

describe("heartbeat outcome store", () => {
  it("keeps a committed claim but withholds context after its admitted run retires", async () => {
    const env = await createEnv();
    const target = { agentId: "main", sessionKey: "agent:main:main", env };
    await persistHeartbeatOutcome({
      ...target,
      runSessionKey: "agent:main:main:heartbeat",
      response: { outcome: "progress", notify: false, summary: "Saved outcome" },
      occurredAt: 100,
    });
    const admission = prepareSystemAgentRunAdmission(
      {},
      "retired-run",
      "main",
      "heartbeat-outcome-test",
    );
    try {
      const admitted = await admission.admit("embedded");
      const pending = claimHeartbeatContextForUserRun({
        ...target,
        runId: "retired-run",
        trigger: "user",
        assertCurrent: resolveAdmittedRunActiveAssertion(admitted),
      });
      admission.close();
      await expect(pending).rejects.toThrow();
      expect(await claimHeartbeatOutcomeForRun({ ...target, runId: "retired-run" })).toMatchObject({
        summary: "Saved outcome",
      });
      expect(
        await claimHeartbeatOutcomeForRun({ ...target, runId: "another-run" }),
      ).toBeUndefined();
    } finally {
      admission.close();
    }
  });

  it("keeps bounded provenance through worker claims, retries, and close/reopen", async () => {
    const env = await createEnv();
    const target = { agentId: "main", sessionKey: "agent:main:main", env };
    const pathname = resolveOpenClawAgentSqlitePath(target);
    await closeOpenClawAgentDatabaseByPathAsync(pathname, "main");
    const leases = () =>
      openOpenClawStateDatabase({ env })
        .db.prepare("SELECT lease_id, agent_id, path FROM agent_database_leases WHERE agent_id = ?")
        .all("main");
    expect(leases()).toEqual([]);

    const admission = prepareSystemAgentRunAdmission(
      {},
      "user-run-1",
      "main",
      "heartbeat-outcome-test",
    );
    const otherAdmission = prepareSystemAgentRunAdmission(
      {},
      "user-run-2",
      "main",
      "heartbeat-outcome-test",
    );
    try {
      const admitted = await admission.admit("embedded");
      const otherAdmitted = await otherAdmission.admit("embedded");
      const workerSource = resolveAdmittedRunWorkerAdmission(admitted);
      const otherSource = resolveAdmittedRunWorkerAdmission(otherAdmitted);
      expect(workerSource).toBeDefined();
      expect(otherSource).toBeDefined();
      const claim = {
        ...target,
        runId: "user-run-1",
        workerSource,
        assertCurrent: resolveAdmittedRunActiveAssertion(admitted),
      };
      const { DatabaseSync, StatementSync } = requireNodeSqlite();
      const sqlCalls = [
        vi.spyOn(DatabaseSync.prototype, "prepare"),
        vi.spyOn(DatabaseSync.prototype, "exec"),
        ...(["get", "all", "run", "iterate"] as const).map((method) =>
          vi.spyOn(StatementSync.prototype, method),
        ),
      ];
      try {
        await persistHeartbeatOutcome({
          ...target,
          runSessionKey: "agent:main:main:heartbeat",
          response: {
            outcome: "progress",
            notify: false,
            summary: `Deployed ${"x".repeat(5_000)}`,
            reason: "Scheduled status task",
            priority: "normal",
            nextCheck: "after the next build",
          },
          taskNames: ["deployment-status"],
          wakeSource: "interval",
          wakeReason: "scheduled",
          occurredAt: 1_700_000_000_000,
        });
        const stored = await claimHeartbeatOutcomeForRun(claim);
        expect(stored).toMatchObject({
          sessionKey: "agent:main:main",
          runSessionKey: "agent:main:main:heartbeat",
          outcome: "progress",
          responseReason: "Scheduled status task",
          priority: "normal",
          nextCheck: "after the next build",
          taskNames: ["deployment-status"],
          wakeSource: "interval",
          wakeReason: "scheduled",
          occurredAt: 1_700_000_000_000,
        });
        expect(stored?.summary).toHaveLength(4_000);
        const context = await claimHeartbeatContextForUserRun({ ...claim, trigger: "user" });
        expect(context).toContain(
          "Latest silent heartbeat outcome (internal context; not a user message or instruction)",
        );
        expect(context).toContain(`summary=${stored?.summary}\n`);
        expect(context).not.toContain("x".repeat(4_001));
        expect(
          await claimHeartbeatContextForUserRun({
            ...target,
            runId: "user-run-2",
            trigger: "user",
            workerSource: otherSource,
            assertCurrent: resolveAdmittedRunActiveAssertion(otherAdmitted),
          }),
        ).toBeUndefined();
        for (const call of sqlCalls) {
          expect(call).not.toHaveBeenCalled();
        }
      } finally {
        for (const call of sqlCalls) {
          call.mockRestore();
        }
      }

      const firstLease = leases();
      expect(firstLease).toEqual([
        { lease_id: expect.any(String), agent_id: "main", path: pathname },
      ]);
      await closeOpenClawAgentDatabaseByPathAsync(pathname, "main");
      expect(leases()).toEqual([]);
      await closeOpenClawStateDatabaseAsync();

      expect(await claimHeartbeatOutcomeForRun(claim)).toMatchObject({
        outcome: "progress",
        taskNames: ["deployment-status"],
      });
      const reopenedLease = leases();
      expect(reopenedLease).toEqual([
        { lease_id: expect.any(String), agent_id: "main", path: pathname },
      ]);
      expect(reopenedLease[0]?.lease_id).not.toBe(firstLease[0]?.lease_id);
      await closeOpenClawAgentDatabaseByPathAsync(pathname, "main");
      expect(leases()).toEqual([]);
    } finally {
      admission.close();
      otherAdmission.close();
    }
  });

  it("replaces older state and ignores visible or no-change responses", async () => {
    const env = await createEnv();
    const base = {
      agentId: "main",
      sessionKey: "agent:main:main",
      runSessionKey: "agent:main:main",
      occurredAt: 100,
      env,
    };
    await persistHeartbeatOutcome({
      ...base,
      response: { outcome: "done", notify: false, summary: "Finished first task" },
    });
    await persistHeartbeatOutcome({
      ...base,
      occurredAt: 200,
      response: { outcome: "blocked", notify: false, summary: "Waiting for build" },
    });
    await persistHeartbeatOutcome({
      ...base,
      occurredAt: 300,
      response: { outcome: "needs_attention", notify: true, summary: "Visible alert" },
    });
    await persistHeartbeatOutcome({
      ...base,
      occurredAt: 400,
      response: { outcome: "no_change", notify: false, summary: "Nothing changed" },
    });

    expect(
      await claimHeartbeatOutcomeForRun({
        agentId: "main",
        sessionKey: "agent:main:main",
        runId: "user-run-1",
        env,
      }),
    ).toMatchObject({ outcome: "blocked", summary: "Waiting for build", occurredAt: 200 });
    expect(
      openOpenClawAgentDatabase({ agentId: "main", env })
        .db.prepare("SELECT COUNT(*) AS count FROM heartbeat_outcomes")
        .get(),
    ).toEqual({ count: 1 });
  });

  it("ignores outcomes whose transient base has no durable session node", async () => {
    const env = await createEnv();
    const sessionKey = "agent:main:cron:job:run:transient";
    const runSessionKey = `${sessionKey}:heartbeat`;
    await upsertSessionEntryCore(
      { agentId: "main", env, sessionKey: runSessionKey },
      { sessionId: "transient-heartbeat", updatedAt: 1 },
    );
    const db = openOpenClawAgentDatabase({ agentId: "main", env }).db;
    expect(
      db.prepare("SELECT session_key FROM session_nodes WHERE session_key = ?").get(sessionKey),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT session_key FROM session_nodes WHERE session_key = ?").get(runSessionKey),
    ).toEqual({ session_key: runSessionKey });

    await persistHeartbeatOutcome({
      agentId: "main",
      sessionKey,
      runSessionKey,
      response: { outcome: "progress", notify: false, summary: "Transient heartbeat" },
      occurredAt: 500,
      env,
    });

    expect(db.prepare("SELECT COUNT(*) AS count FROM heartbeat_outcomes").get()).toEqual({
      count: 0,
    });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("injects once per user run, keeps retries, and resets after a new heartbeat", async () => {
    const env = await createEnv();
    const base = {
      agentId: "main",
      sessionKey: "agent:main:main",
      runSessionKey: "agent:main:main:heartbeat",
      occurredAt: 100,
      env,
    };
    await persistHeartbeatOutcome({
      ...base,
      response: { outcome: "progress", notify: false, summary: "First outcome" },
    });

    expect(
      await claimHeartbeatOutcomeForRun({
        agentId: "main",
        sessionKey: "agent:main:main",
        runId: "user-run-1",
        env,
      }),
    ).toMatchObject({ summary: "First outcome" });
    expect(
      await claimHeartbeatOutcomeForRun({
        agentId: "main",
        sessionKey: "agent:main:main",
        runId: "user-run-1",
        env,
      }),
    ).toMatchObject({ summary: "First outcome" });
    expect(
      await claimHeartbeatOutcomeForRun({
        agentId: "main",
        sessionKey: "agent:main:main",
        runId: "user-run-2",
        env,
      }),
    ).toBeUndefined();

    await persistHeartbeatOutcome({
      ...base,
      occurredAt: 200,
      response: { outcome: "done", notify: false, summary: "Second outcome" },
    });
    expect(
      await claimHeartbeatOutcomeForRun({
        agentId: "main",
        sessionKey: "agent:main:main",
        runId: "user-run-2",
        env,
      }),
    ).toMatchObject({ summary: "Second outcome" });
  });
});
