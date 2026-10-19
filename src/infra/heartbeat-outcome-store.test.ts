import { existsSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../agents/admitted-run-context.js";
import { captureRuntimeConfigAsyncReader, getRuntimeConfig } from "../config/config.js";
import {
  getRuntimeConfigSourceSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
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
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import {
  claimHeartbeatContextForUserRun,
  claimHeartbeatOutcomeForRun,
  persistHeartbeatOutcome,
} from "./heartbeat-outcome-store.js";
import { readSqliteDatabaseWriteTokenForPath } from "./sqlite-database-admission.js";
import * as workerAdmission from "./sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe } from "./sqlite-worker-owner-probe.test-support.js";

const tempDirs = createTempDirTracker();
type Target = ReturnType<typeof sessionTarget>;
type OutcomeInput = Parameters<typeof persistHeartbeatOutcome>[0];

function sessionTarget(env: NodeJS.ProcessEnv, sessionKey = "agent:main:main") {
  return { agentId: "main", sessionKey, env };
}

function buildOutcome(target: Target, summary: string, overrides: Partial<OutcomeInput> = {}) {
  return {
    ...target,
    runSessionKey: `${target.sessionKey}:heartbeat`,
    occurredAt: 100,
    response: { outcome: "progress" as const, notify: false, summary },
    ...overrides,
  };
}

function persist(target: Target, summary: string, overrides: Partial<OutcomeInput> = {}) {
  return persistHeartbeatOutcome(buildOutcome(target, summary, overrides));
}

function claimOutcome(target: Target, runId: string) {
  return claimHeartbeatOutcomeForRun({ ...target, runId });
}

async function expectSummary(target: Target, runId: string, summary: string) {
  expect(await claimOutcome(target, runId)).toMatchObject({ summary });
}

async function withUserRun(
  target: Target,
  runId: string,
  run: (claim: () => Promise<string | undefined>, retire: () => void) => Promise<void>,
) {
  const admission = prepareSystemAgentRunAdmission({}, runId, "main", "heartbeat-outcome-test");
  try {
    const admitted = await admission.admit("embedded");
    const assertCurrent = resolveAdmittedRunActiveAssertion(admitted);
    await run(
      () => claimHeartbeatContextForUserRun({ ...target, runId, trigger: "user", assertCurrent }),
      () => admission.close(),
    );
  } finally {
    admission.close();
  }
}

beforeEach(() => captureRuntimeConfigAsyncReader()());

async function createTarget(sessionKey = "agent:main:main", sessionId = "heartbeat-outcome-test") {
  const target = freshTarget(sessionKey);
  await upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
  return target;
}

function freshTarget(sessionKey?: string) {
  return sessionTarget({ OPENCLAW_STATE_DIR: tempDirs.make("heartbeat-outcome-") }, sessionKey);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

it("persists and claims the first outcome after reopening without host SQL", async () => {
  const target = await createTarget();
  await closeOpenClawAgentDatabasesAsync();
  const host = observeHostDataSql();
  try {
    await persist(target, "First after boot");
    await expectSummary(target, "first-run", "First after boot");
    expect(host.queries).toEqual([]);
  } finally {
    host.restore();
  }
  await closeOpenClawAgentDatabasesAsync();
  await expectSummary(target, "first-run", "First after boot");
  expect(await claimOutcome(target, "second-run")).toBeUndefined();
});

it("preserves absent storage when there is no durable base session", async () => {
  const target = freshTarget();
  await persist(target, "No durable session");
  expect(await claimOutcome(target, "first-run")).toBeUndefined();
  expect(existsSync(resolveOpenClawAgentSqlitePath(target))).toBe(false);
});

it("claims once without writing absent outcomes, durable retries, or another run's claim", async ({
  onTestFinished,
}) => {
  const config = getRuntimeConfig();
  const sourceConfig = getRuntimeConfigSourceSnapshot();
  onTestFinished(() => setRuntimeConfigSnapshot(config, sourceConfig ?? undefined));
  // Count heartbeat writes without the fixture's independent automatic maintenance commit.
  setRuntimeConfigSnapshot({
    ...config,
    session: {
      ...config.session,
      maintenance: { ...config.session?.maintenance, mode: "warn" },
    },
  });
  const target = await createTarget();
  let commits = 0;
  let admissions = 0;
  sqliteWorkerOwnerProbe.admission(workerAdmission, (request, grant, admit) => {
    if (request.stage === "transaction") {
      admissions++;
    }
    if (request.stage === "commit") {
      commits++;
    }
    admit(request, grant);
  });
  const claim = (runId: string) => claimOutcome(target, runId);

  expect(await claim("first-run")).toBeUndefined();
  expect(commits).toBe(0);
  const afterAbsent = admissions;
  // Gateway presentation notifications carry no storage mutation facts.
  sessionChanges.emit({ agentId: target.agentId, sessionKey: target.sessionKey });
  expect(await claim("first-run")).toBeUndefined();
  expect(await claim("second-run")).toBeUndefined();
  expect(admissions).toBe(afterAbsent);
  await persist(target, "Recorded progress");
  expect(commits).toBe(1);
  const claimed = await claim("first-run");
  expect(claimed).toMatchObject({ summary: "Recorded progress" });
  expect(commits).toBe(2);
  const afterClaim = admissions;
  sessionChanges.emit({ agentId: target.agentId, sessionKey: target.sessionKey });
  expect(await claim("first-run")).toEqual(claimed);
  expect(await claim("second-run")).toBeUndefined();
  expect(commits).toBe(2);
  expect(admissions).toBe(afterClaim);
});

it("leaves the outcome unclaimed when its admitted run retires before worker admission", async () => {
  const target = await createTarget();
  await persist(target, "Saved outcome");
  await withUserRun(target, "retired-run", async (claim, retire) => {
    const pending = claim();
    retire();
    await expect(pending).rejects.toThrow();
    await expectSummary(target, "another-run", "Saved outcome");
    expect(await claimOutcome(target, "retired-run")).toBeUndefined();
  });
});

it("does not reopen an agent for persistence queued before its close", async () => {
  const target = await createTarget();
  const blocked = createDeferredCore();
  const ahead = runOpenClawAgentWriteAdmission(target, () => blocked.promise);
  const pending = persist(target, "Must not reopen");
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
  const target = await createTarget("agent:main:dashboard:incognito-heartbeat", "private-session");
  await persist(target, "Private progress");
  await expectSummary(target, "private-user", "Private progress");
  await expectSummary(target, "private-user", "Private progress");
  expect(await claimOutcome(target, "another-user")).toBeUndefined();
  const memoryPath = resolveIncognitoOpenClawAgentSqlitePath(target);
  expect(
    memorySessionActorOwners
      .read({ agentId: target.agentId, path: memoryPath })
      ?.readSession(target.sessionKey, { assertCurrent() {}, authorize() {} })?.entry?.sessionId,
  ).toBe("private-session");
  expect(getOpenClawAgentDatabaseIfOpen({ ...target, path: memoryPath })).toBeUndefined();
  expect(existsSync(memoryPath)).toBe(false);
  expect(existsSync(resolveOpenClawAgentSqlitePath(target))).toBe(false);
});

it("keeps one bounded typed outcome per base session with provenance", async () => {
  const target = await createTarget();
  await persist(target, "", {
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

  const stored = await claimOutcome(target, "user-run-1");
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
  await withUserRun(target, "user-run-1", async (claim) => {
    const context = await claim();
    expect(context).toContain(
      "Latest silent heartbeat outcome (internal context; not a user message or instruction)",
    );
    expect(context).toContain(`summary=${stored?.summary}\n`);
    expect(context).not.toContain("x".repeat(4_001));
  });
});

it("replaces older state and ignores visible or no-change responses", async () => {
  const target = await createTarget();
  const record = (
    outcome: OutcomeInput["response"]["outcome"],
    summary: string,
    occurredAt: number,
    notify = false,
  ) =>
    persist(target, summary, {
      runSessionKey: target.sessionKey,
      occurredAt,
      response: { outcome, notify, summary },
    });
  await record("done", "Finished first task", 100);
  await record("blocked", "Waiting for build", 200);
  const release = await reserveWorker(target.env);
  let settled = false;
  const skipped = Promise.all([
    record("needs_attention", "Visible alert", 300, true),
    record("no_change", "Nothing changed", 400),
  ]).then(() => {
    settled = true;
  });
  try {
    await setImmediate();
    expect(settled).toBe(true);
  } finally {
    await release();
    await skipped;
  }

  expect(await claimOutcome(target, "user-run-1")).toMatchObject({
    outcome: "blocked",
    summary: "Waiting for build",
    occurredAt: 200,
  });
  expectOutcomeCount(target, 1);
});

it("ignores outcomes whose transient base has no durable session node", async () => {
  const target = await createTarget();
  const { env } = target;
  const sessionKey = "agent:main:cron:job:run:transient";
  const runSessionKey = `${sessionKey}:heartbeat`;
  await upsertSessionEntryCore(
    { agentId: "main", env, sessionKey: runSessionKey },
    { sessionId: "transient-heartbeat", updatedAt: 1 },
  );
  const db = openOpenClawAgentDatabase(target).db;
  const node = (key: string) =>
    db.prepare("SELECT session_key FROM session_nodes WHERE session_key = ?").get(key);
  expect([node(sessionKey), node(runSessionKey)]).toEqual([
    undefined,
    { session_key: runSessionKey },
  ]);

  await persist(sessionTarget(env, sessionKey), "Transient heartbeat", {
    runSessionKey,
    occurredAt: 500,
  });

  expectOutcomeCount(target, 0);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

async function reserveWorker(env: NodeJS.ProcessEnv) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const done = runOpenClawAgentWorkerWrite({ agentId: "main", env }, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  return async () => {
    release.resolve();
    await done;
  };
}

function expectOutcomeCount(target: Target, count: number) {
  expect(
    openOpenClawAgentDatabase(target)
      .db.prepare("SELECT COUNT(*) AS count FROM heartbeat_outcomes")
      .get(),
  ).toEqual({ count });
}

it("queues captured outcomes off-thread and claims once per run until the next heartbeat", async () => {
  const target = await createTarget();
  const db = requireNativeSqliteDatabase(openOpenClawAgentDatabase(target).db);
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
  const release = await reserveWorker(target.env);
  const input = { ...buildOutcome(target, "captured"), taskNames: ["captured task"] };
  const first = persistHeartbeatOutcome(input);
  const claim = { ...target, runId: "first-run" };
  const claimed = claimHeartbeatOutcomeForRun(claim);
  const retry = claimHeartbeatOutcomeForRun(claim);
  const alreadyClaimed = claimOutcome(target, "second-run");
  const second = persistHeartbeatOutcome({
    ...input,
    response: { outcome: "done", notify: false, summary: "second" },
  });
  const claimedSecond = claimOutcome(target, "second-run");
  input.sessionKey = "agent:main:changed";
  input.response.summary = "changed";
  input.taskNames[0] = "changed";
  claim.runId = "changed-run";
  claim.sessionKey = "agent:main:changed";
  try {
    await setImmediate();
    expect(db.prepare("SELECT * FROM heartbeat_outcomes").all()).toEqual([]);
  } finally {
    await release();
    await Promise.all([first, claimed, retry, alreadyClaimed, second, claimedSecond]);
  }
  expect(await claimed).toMatchObject({ summary: "captured", taskNames: ["captured task"] });
  expect(await retry).toMatchObject({ summary: "captured" });
  expect(await alreadyClaimed).toBeUndefined();
  expect(await claimedSecond).toMatchObject({ summary: "second" });
  expect(readSqliteDatabaseWriteTokenForPath(databasePath)).not.toBe(initialWriteToken);
  expect(await claimOutcome(target, "third-run")).toBeUndefined();
  db.prepare("UPDATE heartbeat_outcomes SET context_claimed_at = 123 WHERE session_key = ?").run(
    target.sessionKey,
  );
  await expectSummary(target, "second-run", "second");
  expect(
    db
      .prepare("SELECT context_claimed_at FROM heartbeat_outcomes WHERE session_key = ?")
      .get(target.sessionKey),
  ).toEqual({ context_claimed_at: 123 });
});

it("rechecks a queued claim's captured authority and leaves the outcome unclaimed", async () => {
  const target = await createTarget();
  await persist(target, "unclaimed");
  const release = await reserveWorker(target.env);
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
  await release();
  await rejected;
  await expectSummary(target, "current-run", "unclaimed");
});
