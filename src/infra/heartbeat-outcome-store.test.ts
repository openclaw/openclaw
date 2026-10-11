import { existsSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../agents/admitted-run-context.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { createDeferredCore } from "../shared/deferred.js";
import { readOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  getOpenClawAgentDatabaseIfOpen,
} from "../state/openclaw-agent-db.js";
import {
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.paths.js";
import {
  runOpenClawAgentWorkerWrite,
  runOpenClawAgentWriteAdmission,
} from "../state/openclaw-agent-write-admission.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import {
  claimHeartbeatContextForUserRun,
  claimHeartbeatOutcomeForRun,
  persistHeartbeatOutcome,
} from "./heartbeat-outcome-store.js";
import { readSqliteDatabaseWriteTokenForPath } from "./sqlite-database-admission.js";

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
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

describe("heartbeat outcome store", () => {
  it("leaves the outcome unclaimed when its admitted run retires before worker admission", async () => {
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
      expect(await claimHeartbeatOutcomeForRun({ ...target, runId: "another-run" })).toMatchObject({
        summary: "Saved outcome",
      });
      expect(
        await claimHeartbeatOutcomeForRun({ ...target, runId: "retired-run" }),
      ).toBeUndefined();
    } finally {
      admission.close();
    }
  });

  it("does not reopen an agent for persistence queued before its close", async () => {
    const env = await createEnv();
    const target = { agentId: "main", sessionKey: "agent:main:main", env };
    const blocked = createDeferredCore();
    const ahead = runOpenClawAgentWriteAdmission(target, () => blocked.promise);
    const pending = persistHeartbeatOutcome({
      ...target,
      runSessionKey: "agent:main:main:heartbeat",
      occurredAt: 100,
      response: { outcome: "progress", notify: false, summary: "Must not reopen" },
    });
    const refused = expect(pending).rejects.toThrow("closed");
    try {
      await closeOpenClawAgentDatabasesAsync();
    } finally {
      blocked.resolve();
    }
    await ahead;
    await refused;
    expect(getOpenClawAgentDatabaseIfOpen(target)).toBeUndefined();
  });

  it("retains incognito outcomes on the existing in-memory session owner", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-heartbeat-incognito-") };
    const target = { agentId: "main", sessionKey: "agent:main:dashboard:incognito-heartbeat", env };
    await upsertSessionEntryCore(target, { sessionId: "private-session", updatedAt: 1 });
    await persistHeartbeatOutcome({
      ...target,
      runSessionKey: "agent:main:dashboard:incognito-heartbeat:heartbeat",
      occurredAt: 100,
      response: { outcome: "progress", notify: false, summary: "Private progress" },
    });
    expect(await claimHeartbeatOutcomeForRun({ ...target, runId: "private-user" })).toMatchObject({
      summary: "Private progress",
    });
    expect(await claimHeartbeatOutcomeForRun({ ...target, runId: "private-user" })).toMatchObject({
      summary: "Private progress",
    });
    expect(await claimHeartbeatOutcomeForRun({ ...target, runId: "another-user" })).toBeUndefined();
    const memoryPath = resolveIncognitoOpenClawAgentSqlitePath(target);
    const database = getOpenClawAgentDatabaseIfOpen({ ...target, path: memoryPath });
    const identity = readOpenClawAgentDatabaseIdentity(
      expectDefined(database, "Incognito session must retain its memory database"),
    );
    expect(typeof identity.identity).toBe("symbol");
    expect(identity.filename).toBe("");
    expect(existsSync(memoryPath)).toBe(false);
    expect(existsSync(resolveOpenClawAgentSqlitePath(target))).toBe(false);
  });

  it("keeps one bounded typed outcome per base session with provenance", async () => {
    const env = await createEnv();
    await persistHeartbeatOutcome({
      agentId: "main",
      sessionKey: "agent:main:main",
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
      env,
    });

    const stored = await claimHeartbeatOutcomeForRun({
      agentId: "main",
      sessionKey: "agent:main:main",
      runId: "user-run-1",
      env,
    });
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
    const admission = prepareSystemAgentRunAdmission(
      {},
      "user-run-1",
      "main",
      "heartbeat-outcome-test",
    );
    try {
      const admitted = await admission.admit("embedded");
      const context = await claimHeartbeatContextForUserRun({
        agentId: "main",
        sessionKey: "agent:main:main",
        runId: "user-run-1",
        trigger: "user",
        env,
        assertCurrent: resolveAdmittedRunActiveAssertion(admitted),
      });
      expect(context).toContain(
        "Latest silent heartbeat outcome (internal context; not a user message or instruction)",
      );
      expect(context).toContain(`summary=${stored?.summary}\n`);
      expect(context).not.toContain("x".repeat(4_001));
    } finally {
      admission.close();
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
    const reservation = await reserveWorker(env);
    let settled = false;
    const skipped = Promise.all([
      persistHeartbeatOutcome({
        ...base,
        occurredAt: 300,
        response: { outcome: "needs_attention", notify: true, summary: "Visible alert" },
      }),
      persistHeartbeatOutcome({
        ...base,
        occurredAt: 400,
        response: { outcome: "no_change", notify: false, summary: "Nothing changed" },
      }),
    ]).then(() => {
      settled = true;
    });
    try {
      await setImmediate();
      expect(settled).toBe(true);
    } finally {
      reservation.release();
      await reservation.done;
      await skipped;
    }

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
});

async function reserveWorker(env: NodeJS.ProcessEnv) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const done = runOpenClawAgentWorkerWrite({ agentId: "main", env }, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  return { done, release: release.resolve };
}

it("queues captured outcomes off-thread and claims once per run until the next heartbeat", async () => {
  const env = await createEnv();
  const target = { agentId: "main", sessionKey: "agent:main:main", env };
  const db = openOpenClawAgentDatabase(target).db;
  const databasePath = resolveOpenClawAgentSqlitePath(target);
  const initialWriteToken = readSqliteDatabaseWriteTokenForPath(databasePath);
  expect(initialWriteToken).toBeTypeOf("string");
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation((sql) => {
    if (sql.includes('"heartbeat_outcomes"')) {
      throw new Error("Heartbeat SQL ran on the caller");
    }
    return prepare(sql);
  });
  const reservation = await reserveWorker(env);
  const input = {
    ...target,
    runSessionKey: "agent:main:main:heartbeat",
    response: { outcome: "progress" as const, notify: false, summary: "captured" },
    taskNames: ["captured task"],
    occurredAt: 100,
  };
  const first = persistHeartbeatOutcome(input);
  const claim = { ...target, runId: "first-run" };
  const claimed = claimHeartbeatOutcomeForRun(claim);
  const retry = claimHeartbeatOutcomeForRun(claim);
  const alreadyClaimed = claimHeartbeatOutcomeForRun({ ...target, runId: "second-run" });
  const second = persistHeartbeatOutcome({
    ...input,
    response: { outcome: "done", notify: false, summary: "second" },
  });
  const claimedSecond = claimHeartbeatOutcomeForRun({ ...target, runId: "second-run" });
  input.sessionKey = "agent:main:changed";
  input.response.summary = "changed";
  input.taskNames[0] = "changed";
  claim.runId = "changed-run";
  claim.sessionKey = "agent:main:changed";
  try {
    await setImmediate();
    expect(db.prepare("SELECT * FROM heartbeat_outcomes").all()).toEqual([]);
  } finally {
    reservation.release();
    await reservation.done;
    await Promise.all([first, claimed, retry, alreadyClaimed, second, claimedSecond]);
  }
  expect(await claimed).toMatchObject({ summary: "captured", taskNames: ["captured task"] });
  expect(await retry).toMatchObject({ summary: "captured" });
  expect(await alreadyClaimed).toBeUndefined();
  expect(await claimedSecond).toMatchObject({ summary: "second" });
  expect(readSqliteDatabaseWriteTokenForPath(databasePath)).not.toBe(initialWriteToken);
  expect(await claimHeartbeatOutcomeForRun({ ...target, runId: "third-run" })).toBeUndefined();
  db.prepare("UPDATE heartbeat_outcomes SET context_claimed_at = 123 WHERE session_key = ?").run(
    target.sessionKey,
  );
  expect(await claimHeartbeatOutcomeForRun({ ...target, runId: "second-run" })).toMatchObject({
    summary: "second",
  });
  expect(
    db
      .prepare("SELECT context_claimed_at FROM heartbeat_outcomes WHERE session_key = ?")
      .get(target.sessionKey),
  ).toEqual({ context_claimed_at: 123 });
});

it("rechecks a queued claim's captured authority and leaves the outcome unclaimed", async () => {
  const env = await createEnv();
  const target = { agentId: "main", sessionKey: "agent:main:main", env };
  await persistHeartbeatOutcome({
    ...target,
    runSessionKey: "agent:main:main:heartbeat",
    response: { outcome: "progress", notify: false, summary: "unclaimed" },
    occurredAt: 100,
  });
  const reservation = await reserveWorker(env);
  let current = true;
  const input = {
    ...target,
    runId: "retired-run",
    assertCurrent() {
      if (!current) {
        throw new Error("authority retired");
      }
    },
  };
  const claim = claimHeartbeatOutcomeForRun(input);
  const rejected = expect(claim).rejects.toThrow("authority retired");
  current = false;
  input.assertCurrent = () => {};
  reservation.release();
  await reservation.done;
  await rejected;
  expect(await claimHeartbeatOutcomeForRun({ ...target, runId: "current-run" })).toMatchObject({
    summary: "unclaimed",
  });
});
