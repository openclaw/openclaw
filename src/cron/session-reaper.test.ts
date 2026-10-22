import fsPromises from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { withAgentDeletion } from "../agents/agent-lifecycle-registry.js";
import * as mediaGeneration from "../agents/media-generation-activity.js";
import { resetGeneratedMediaTaskActivityForTests } from "../agents/media-generation-activity.test-support.js";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { clearSubagentRunsReadCacheForTest } from "../agents/subagents/registry/subagent-registry-state.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { loadCombinedSessionStoreForGatewayCore } from "../config/sessions/combined-store-gateway.native.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import * as maintenanceReads from "../config/sessions/session-entry-read-maintenance.js";
import * as sessionEntryReader from "../config/sessions/session-entry-read-runtime.js";
import {
  maintenanceLane,
  targetDiscoveryLane,
} from "../config/sessions/session-transcript-worker-resources.js";
import {
  listKnownSessionStoreAgentIds,
  resolveExistingAgentSessionStoreTargetsSync,
} from "../config/sessions/targets-discovery.native.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.js";
import { initializeSqliteRuntimeCapabilities } from "../infra/bun-sqlite-library.js";
import { beginSessionEffect } from "../sessions/session-controller.lifecycle.js";
import {
  listOpenClawRegisteredAgentDatabases,
  unregisterOpenClawAgentDatabase,
} from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import { isSameOpenClawAgentDatabasePath } from "../state/openclaw-agent-db.paths.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { drainSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import type { Logger } from "./service/state.js";
import { sweepCronRunSessions as sweepCronRunSessionsImpl } from "./session-reaper.js";
import { resetReaperThrottle, seedSessionEntries } from "./session-reaper.test-support.js";

const { listSessionEntriesCore, patchSessionEntryCore, replaceSessionEntry } = sessionAccessor;
const { explicitSqliteCloseReleasesNativeResources: keepsMaintenanceWorker } =
  await initializeSqliteRuntimeCapabilities();

function readSessionEntries(storePath: string): Record<string, SessionEntry> {
  return Object.fromEntries(
    listSessionEntriesCore({ agentId: "main", storePath }).map(({ sessionKey, entry }) => [
      sessionKey,
      entry,
    ]),
  );
}

describe("sweepCronRunSessions", () => {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>> | undefined;
  let tmpDir: string;
  let storePath: string;
  let now: number;
  let buildPendingSet: MockInstance<typeof mediaGeneration.buildPendingGeneratedMediaSessionKeySet>;
  const log = {
    debug: vi.fn<Logger["debug"]>(),
    info: vi.fn<Logger["info"]>(),
    warn: vi.fn<Logger["warn"]>(),
    error: vi.fn<Logger["error"]>(),
  } satisfies Logger;
  const sweep = (
    nowMs: number,
    overrides: Partial<Parameters<typeof sweepCronRunSessionsImpl>[0]> = {},
  ) =>
    sweepCronRunSessionsImpl({
      agentId: "main",
      sessionStorePath: storePath,
      nowMs,
      log,
      ...overrides,
    });
  const writeEntry = (sessionKey: string, entry: SessionEntry) =>
    replaceSessionEntry({ agentId: "main", storePath, sessionKey }, entry);
  const expiredRun = (sessionId: string, overrides: Partial<SessionEntry> = {}): SessionEntry => ({
    sessionId,
    updatedAt: now - 25 * 3_600_000,
    ...overrides,
  });
  const continuation = (sessionId: string) =>
    expiredRun(sessionId, {
      delivery: { kind: "none" },
      cronRunContinuation: {
        lifecycleRevision: "revision-parent",
        phase: "ready",
        basePersisted: true,
      },
    });
  async function holdWriter(sessionKey: string) {
    const entered = createDeferred();
    const released = createDeferred();
    const writer = patchSessionEntryCore({ storePath, sessionKey }, async () => {
      entered.resolve();
      await released.promise;
      return {};
    });
    await entered.promise;
    return { writer, release: () => released.resolve() };
  }
  const sharedScope = (target: string, agentId: string, sessionKey: string) => ({
    agentId,
    defaultAgentId: "main",
    storePath: target,
    sessionKey,
  });

  beforeEach(async () => {
    state = await createOpenClawTestState({
      scenario: "minimal",
      env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" },
    });
    tmpDir = state.root;
    storePath = path.join(tmpDir, "sessions.json");
    now = Date.now();
    resetReaperThrottle();
    subagentRuns.clear();
    clearSubagentRunsReadCacheForTest();
    resetGeneratedMediaTaskActivityForTests();
    log.warn.mockClear();
    buildPendingSet = vi.spyOn(mediaGeneration, "buildPendingGeneratedMediaSessionKeySet");
  });

  afterEach(async () => {
    buildPendingSet?.mockRestore();
    if (!state) {
      return;
    }
    await drainSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
    subagentRuns.clear();
    clearSubagentRunsReadCacheForTest();
    resetGeneratedMediaTaskActivityForTests();
    await state.cleanup();
    state = undefined;
  });

  it("observes a committed deletion after an earlier sweep without host SQL", async () => {
    const sessionKey = "agent:main:cron:job:run:deleting";
    await writeEntry(sessionKey, { sessionId: "deleting", updatedAt: now });
    expect(await sweep(now)).toEqual({
      swept: true,
      pruned: 0,
    });
    await withAgentDeletion("main", async (begin) => {
      const deletion = await begin({
        agentId: "main",
        agentDir: state!.agentDir("main"),
        workspaceDir: state!.workspaceDir,
        sessionsDir: state!.sessionsDir("main"),
        phase: "draining",
      });
      const hostSql = observeHostDataSql();
      try {
        expect(await sweep(now + 26 * 3_600_000)).toEqual({ swept: false, pruned: 0 });
        expect(hostSql.queries).toEqual([]);
      } finally {
        hostSql.restore();
        await deletion.rollback();
      }
    });
    expect(readSessionEntries(storePath)[sessionKey]?.sessionId).toBe("deleting");
  });

  it("leaves a store without cron runs idle until a committed run needs retention", async () => {
    await writeEntry("agent:main:main", { sessionId: "interactive", updatedAt: now });
    expect(await sweep(now)).toEqual({ swept: true, pruned: 0 });
    expect(await sweep(now + 5 * 60_000)).toEqual({ swept: false, pruned: 0 });

    await writeEntry("agent:main:main", { sessionId: "interactive", updatedAt: now + 5 * 60_000 });
    expect(await sweep(now + 10 * 60_000)).toEqual({ swept: false, pruned: 0 });

    const sessionKey = "agent:main:cron:job:run:late-insert";
    await writeEntry(sessionKey, { sessionId: "late-insert", updatedAt: now - 25 * 3_600_000 });
    expect(await sweep(now + 10 * 60_000)).toEqual({ swept: true, pruned: 1 });
    expect(readSessionEntries(storePath)[sessionKey]).toBeUndefined();
  });

  it("waits for the next cron run expiry and observes an earlier committed timestamp", async () => {
    const sessionKey = "agent:main:cron:job:run:rescheduled";
    await writeEntry(sessionKey, { sessionId: "rescheduled", updatedAt: now });
    expect(await sweep(now)).toEqual({ swept: true, pruned: 0 });
    expect(await sweep(now + 5 * 60_000)).toEqual({ swept: false, pruned: 0 });

    await writeEntry(sessionKey, { sessionId: "rescheduled", updatedAt: now - 23 * 3_600_000 });
    expect(await sweep(now + 10 * 60_000)).toEqual({ swept: true, pruned: 0 });
    expect(await sweep(now + 3_600_000)).toEqual({ swept: false, pruned: 0 });
    expect(await sweep(now + 3_600_000 + 1)).toEqual({ swept: true, pruned: 1 });
    expect(readSessionEntries(storePath)[sessionKey]).toBeUndefined();
  });

  it("keeps a candidate whose retained prompt changes after worker discovery", async () => {
    const sessionKey = "agent:main:cron:job:run:changed";
    const entry = expiredRun("changed", {
      skillsSnapshot: { prompt: "before", skills: [] },
    });
    await writeEntry(sessionKey, entry);
    const read = maintenanceReads.readExpiredCronRunEntriesInWorker;
    const intercept = vi
      .spyOn(maintenanceReads, "readExpiredCronRunEntriesInWorker")
      .mockImplementationOnce(async (input) => {
        const candidates = await read(input);
        expect(candidates.entries[0]?.entry.skillsSnapshot?.prompt).toBe("before");
        await writeEntry(sessionKey, { ...entry, skillsSnapshot: { prompt: "after", skills: [] } });
        return candidates;
      });
    try {
      expect((await sweep(now)).pruned).toBe(0);
      expect(readSessionEntries(storePath)[sessionKey]?.skillsSnapshot?.prompt).toBe("after");
    } finally {
      intercept.mockRestore();
    }
  });

  it("invalidates the logical cron owner within a shared physical store", async () => {
    const exactStorePath = path.join(tmpDir, "shared-deadlines.sqlite");
    const mainKey = "agent:main:cron:main-job:run:fresh";
    const opsKey = "agent:ops:cron:ops-job:run:changed";
    for (const [agentId, sessionKey] of [
      ["main", mainKey],
      ["ops", opsKey],
    ] as const) {
      await replaceSessionEntry(sharedScope(exactStorePath, agentId, sessionKey), {
        sessionId: `${agentId}-run`,
        updatedAt: now,
      });
    }
    const sweepOwner = (agentId: string, nowMs: number) =>
      sweepCronRunSessionsImpl({ agentId, sessionStorePath: exactStorePath, nowMs, log });
    const readOwner = (agentId: string, sessionKey: string) =>
      sessionAccessor.loadSessionEntry({ agentId, storePath: exactStorePath, sessionKey });
    expect(await sweepOwner("main", now)).toEqual({ swept: true, pruned: 0 });
    expect(await sweepOwner("ops", now)).toEqual({ swept: true, pruned: 0 });

    await replaceSessionEntry(sharedScope(exactStorePath, "ops", opsKey), {
      sessionId: "ops-run",
      updatedAt: now - 25 * 3_600_000,
    });
    expect(await sweepOwner("main", now + 5 * 60_000)).toEqual({ swept: false, pruned: 0 });
    expect(await sweepOwner("ops", now + 5 * 60_000)).toEqual({ swept: true, pruned: 1 });
    expect(readOwner("ops", opsKey)).toBeUndefined();
    expect(readOwner("main", mainKey)).toMatchObject({ sessionId: "main-run" });
  });

  it("commits expired rows and warns when transcript archive retention cleanup fails", async () => {
    const sessionKey = "agent:main:cron:job1:run:cleanup-failure";
    const sessionId = "cleanup-failure";
    const staleArchive = path.join(tmpDir, "older.jsonl.deleted.2026-01-01T00-00-00.000Z");
    const cleanupError = Object.assign(new Error("archive cleanup denied"), { code: "EACCES" });
    const { warn } = log;

    await writeEntry(sessionKey, expiredRun(sessionId));
    await sessionAccessor.appendTranscriptMessage(
      { agentId: "main", sessionId, sessionKey, storePath },
      { cwd: tmpDir, message: { role: "user", content: "archive me" } },
    );
    await fsPromises.writeFile(staleArchive, "stale archive", "utf8");
    setRuntimeConfigSnapshot({
      session: {
        maintenance: {
          maxDiskBytes: false,
          resetArchiveRetention: "1ms",
        },
      },
    });
    const rmSpy = vi.spyOn(fsPromises, "rm").mockRejectedValueOnce(cleanupError);

    try {
      buildPendingSet.mockClear();
      const result = await sweep(now);

      expect(result).toEqual({ swept: true, pruned: 1 });
      expect(buildPendingSet).not.toHaveBeenCalled();
      expect(readSessionEntries(storePath)[sessionKey]).toBeUndefined();
      await fsPromises.access(staleArchive);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        { err: expect.stringContaining("archive cleanup denied") },
        "cron-reaper: transcript cleanup failed",
      );
    } finally {
      rmSpy.mockRestore();
    }
  });

  it("discovers, accesses, and reaps a logical owner in one shared exact store", async () => {
    const exactStorePath = path.join(tmpDir, "shared.sqlite");
    const cfg: OpenClawConfig = {
      session: { store: exactStorePath },
      agents: { entries: { main: {} } },
    };
    const mainKey = "agent:main:cron:main-job:run:keep";
    const opsKey = "agent:ops:cron:ops-job:run:expired";
    const mainScope = sharedScope(exactStorePath, "main", mainKey);
    const opsScope = sharedScope(exactStorePath, "ops", opsKey);
    const foregroundEntry = {
      sessionId: "main-run",
      skillsSnapshot: { prompt: "foreground prompt", skills: [] },
    };
    await replaceSessionEntry(mainScope, {
      ...foregroundEntry,
      updatedAt: now - 1 * 3_600_000,
    });
    await replaceSessionEntry(opsScope, { sessionId: "ops-run", updatedAt: now - 25 * 3_600_000 });
    await closeOpenClawAgentDatabaseByPathAsync(exactStorePath);
    closeOpenClawAgentDatabasesForTest(exactStorePath);
    unregisterOpenClawAgentDatabase({ agentId: "main", path: exactStorePath });
    expect(
      listOpenClawRegisteredAgentDatabases().filter((entry) =>
        isSameOpenClawAgentDatabasePath(entry.path, exactStorePath),
      ),
    ).toEqual([]);

    expect(listKnownSessionStoreAgentIds(cfg).toSorted()).toEqual(["main", "ops"]);
    expect(resolveExistingAgentSessionStoreTargetsSync(cfg, "ops")).toEqual([
      { agentId: "ops", storePath: exactStorePath },
    ]);
    expect(Object.keys(loadCombinedSessionStoreForGatewayCore(cfg).store).toSorted()).toEqual([
      mainKey,
      opsKey,
    ]);
    expect(sessionAccessor.loadSessionEntry(opsScope)).toMatchObject({ sessionId: "ops-run" });

    const hostSql = observeHostDataSql();
    const sweepShared = (agentId: string) =>
      sweep(now, { agentId, sessionStorePath: exactStorePath });
    try {
      expect(await sweepShared("main")).toEqual({ swept: true, pruned: 0 });
      expect(buildPendingSet).not.toHaveBeenCalled();
      for (const call of hostSql.calls) {
        expect(call).not.toHaveBeenCalled();
      }
    } finally {
      hostSql.restore();
    }
    const workersCreated = maintenanceLane.pool.getSnapshot().workersCreated;
    let foregroundRead:
      | ReturnType<typeof sessionEntryReader.readSessionEntriesFromStoreInWorker>
      | undefined;
    const closeResources = targetDiscoveryLane.pool.closeResources.bind(targetDiscoveryLane.pool);
    const closeObservation = keepsMaintenanceWorker
      ? vi.spyOn(targetDiscoveryLane.pool, "closeResources").mockImplementationOnce((key) => {
          const closing = closeResources(key);
          foregroundRead = sessionEntryReader.readSessionEntriesFromStoreInWorker({
            agentId: "main",
            storePath: exactStorePath,
            sessionKeys: [mainKey],
          });
          void foregroundRead.catch(() => {});
          return closing;
        })
      : undefined;
    try {
      expect(await sweepShared("ops")).toEqual({ swept: true, pruned: 1 });
      if (keepsMaintenanceWorker) {
        expect(foregroundRead).toBeDefined();
        expect(await foregroundRead).toMatchObject({
          entries: [{ sessionKey: mainKey, entry: foregroundEntry }],
        });
        expect(maintenanceLane.pool.getSnapshot().workersCreated).toBe(workersCreated);
      }
    } finally {
      closeObservation?.mockRestore();
      await Promise.allSettled([foregroundRead]);
    }
    expect(sessionAccessor.loadSessionEntry(mainScope)).toMatchObject({ sessionId: "main-run" });
    expect(sessionAccessor.loadSessionEntry(opsScope)).toBeUndefined();
  });

  it("retains an expired continuation until its native child and completion settle", async () => {
    const parentKey = "agent:main:cron:job1:run:pending-parent";
    const idleKey = "agent:main:cron:job1:run:idle-sibling";
    const parent = continuation("pending-parent");
    await seedSessionEntries(storePath, {
      [parentKey]: parent,
      [idleKey]: { ...parent, sessionId: "idle-sibling" },
    });
    const child = createSubagentRunRecord({
      runId: "pending-child",
      requesterSessionKey: parentKey,
      expectsCompletionMessage: true,
      delivery: { status: "pending" },
    });
    subagentRuns.set(child.runId, child);

    expect(await sweep(now)).toEqual({ swept: true, pruned: 1 });
    expect(readSessionEntries(storePath)).toEqual({ [parentKey]: parent });

    child.execution = { status: "terminal", endedAt: now, outcome: { status: "ok" } };
    child.delivery = { status: "in_progress", disposition: "session_queued" };
    expect(await sweep(now + 5 * 60_000)).toEqual({ swept: true, pruned: 0 });
    expect(readSessionEntries(storePath)).toEqual({ [parentKey]: parent });

    child.delivery = { status: "delivered", disposition: "delivered" };
    expect(await sweep(now + 10 * 60_000)).toEqual({ swept: true, pruned: 1 });
    expect(log.warn).not.toHaveBeenCalled();
    expect(readSessionEntries(storePath)).toEqual({});
  });

  it("retains a continuation when a child is admitted after retention selection", async () => {
    const sessionKey = "agent:main:cron:job1:run:late-child-parent";
    const writerKey = "agent:main:main";
    const parent = continuation("late-child-parent");
    await seedSessionEntries(storePath, {
      [sessionKey]: parent,
      [writerKey]: { sessionId: "unrelated-writer", updatedAt: now },
    });
    const { writer, release } = await holdWriter(writerKey);

    const sweeping = sweep(now);
    const child = createSubagentRunRecord({
      runId: "child-admitted-during-retention",
      requesterSessionKey: sessionKey,
      expectsCompletionMessage: true,
      delivery: { status: "pending" },
    });
    subagentRuns.set(child.runId, child);
    try {
      release();
      const result = await sweeping;
      expect(result).toEqual({ swept: true, pruned: 0 });
      expect(log.warn).not.toHaveBeenCalled();
      expect(readSessionEntries(storePath)[sessionKey]).toEqual(parent);
    } finally {
      release();
      await Promise.allSettled([writer, sweeping]);
    }
  });

  it("preserves an expired run when work is admitted before writer-owned removal", async () => {
    const sessionKey = "agent:main:cron:job1:run:active-run";
    await writeEntry(sessionKey, expiredRun("active-run"));
    const firstValidation = createDeferred();
    const { writer, release } = await holdWriter(sessionKey);

    const sweeping = sweep(now);
    const admissionPromise = beginSessionEffect({
      scope: storePath,
      identities: ["active-run"],
      assertAllowed: () => {
        firstValidation.resolve();
      },
    });
    await firstValidation.promise;

    let admission: Awaited<ReturnType<typeof beginSessionEffect>> | undefined;
    try {
      release();
      const result = await sweeping;
      admission = await admissionPromise;

      expect(result.pruned).toBe(0);
      expect(readSessionEntries(storePath)[sessionKey]).toMatchObject({
        sessionId: "active-run",
        updatedAt: expect.any(Number),
      });
    } finally {
      admission?.release();
      release();
      await Promise.allSettled([writer, sweeping, admissionPromise]);
    }
  });

  it("prunes idle siblings while skipping rows claimed by an in-flight run", async () => {
    const busyKey = "agent:main:cron:job1:run:busy-run";
    const idleKey = "agent:main:cron:job2:run:idle-run";
    await seedSessionEntries(storePath, {
      [busyKey]: expiredRun("busy-run"),
      [idleKey]: expiredRun("idle-run"),
    });

    const admission = await beginSessionEffect({
      scope: storePath,
      identities: ["busy-run"],
      assertAllowed: () => {},
    });
    const { warn } = log;

    try {
      const result = await sweep(now);

      expect(result).toMatchObject({ swept: true, pruned: 1 });
      expect(warn).not.toHaveBeenCalled();
      const remaining = readSessionEntries(storePath);
      expect(remaining[busyKey]).toMatchObject({ sessionId: "busy-run" });
      expect(remaining[idleKey]).toBeUndefined();
    } finally {
      admission.release();
    }

    expect(await sweep(now + 5 * 60_000)).toEqual({ swept: true, pruned: 1 });
    expect(readSessionEntries(storePath)[busyKey]).toBeUndefined();
  });

  it.each([
    { sessionRetention: "not-a-duration", ageHours: 25, swept: true, pruned: 1 },
    { sessionRetention: "1h", ageHours: 2, swept: true, pruned: 1 },
    { sessionRetention: "0h", ageHours: 100, swept: false, pruned: 0 },
  ])(
    "applies retention $sessionRetention",
    async ({ sessionRetention, ageHours, swept, pruned }) => {
      const sessionKey = "agent:main:cron:job1:run:run1";
      await writeEntry(sessionKey, { sessionId: "run1", updatedAt: now - ageHours * 3_600_000 });
      expect(await sweep(now, { cronConfig: { sessionRetention } })).toEqual({ swept, pruned });
      expect(Object.hasOwn(readSessionEntries(storePath), sessionKey)).toBe(!pruned);
    },
  );

  it.each([
    { name: "shortened", ageHours: 2, initial: undefined, next: "1h" },
    { name: "enabled again", ageHours: 25, initial: false, next: undefined },
  ] as const)(
    "recomputes the next expiry when retention is $name",
    async ({ ageHours, initial, next }) => {
      const sessionKey = "agent:main:cron:job1:run:expired-run";
      await writeEntry(sessionKey, {
        sessionId: "expired-run",
        updatedAt: now - ageHours * 3_600_000,
      });
      expect(await sweep(now, { cronConfig: { sessionRetention: initial } })).toEqual({
        swept: initial !== false,
        pruned: 0,
      });
      expect(await sweep(now + 1_000, { cronConfig: { sessionRetention: next } })).toEqual({
        swept: true,
        pruned: 1,
      });
      expect(readSessionEntries(storePath)[sessionKey]).toBeUndefined();
    },
  );

  it("resumes retention cleanup after the wall clock moves backward", async () => {
    const rolledBackNow = now - 3_600_000;
    const sessionKey = "agent:main:cron:job1:run:clock-rollback";

    await expect(sweep(now)).resolves.toEqual({ swept: true, pruned: 0 });

    await writeEntry(
      sessionKey,
      expiredRun("clock-rollback", {
        updatedAt: rolledBackNow - 25 * 3_600_000,
      }),
    );

    await expect(sweep(rolledBackNow)).resolves.toEqual({ swept: true, pruned: 1 });
    expect(readSessionEntries(storePath)[sessionKey]).toBeUndefined();
    await expect(sweep(rolledBackNow + 1_000)).resolves.toEqual({ swept: false, pruned: 0 });
  });

  it("updates throttle after persistence errors so the next tick does not thrash (#105188)", async () => {
    const { warn } = log;
    const eacces = Object.assign(new Error("EACCES: permission denied, open 'sessions.json'"), {
      code: "EACCES",
    });
    const listSpy = vi
      .spyOn(maintenanceReads, "readExpiredCronRunEntriesInWorker")
      .mockRejectedValue(eacces);

    try {
      const first = await sweep(now);
      expect(first).toEqual({ swept: false, pruned: 0 });
      expect(warn).toHaveBeenCalledWith(
        { err: String(eacces) },
        "cron-reaper: failed to sweep session store",
      );
      expect(listSpy).toHaveBeenCalledTimes(1);

      warn.mockClear();
      const immediateRetry = await sweepCronRunSessionsImpl({
        agentId: "MAIN",
        sessionStorePath: `${tmpDir}${path.sep}.${path.sep}sessions.json`,
        nowMs: now + 1_000,
        log,
      });
      expect(immediateRetry).toEqual({ swept: false, pruned: 0 });
      expect(warn).not.toHaveBeenCalled();
      expect(listSpy).toHaveBeenCalledTimes(1);

      const afterCooldown = await sweep(now + 5 * 60_000);
      expect(afterCooldown).toEqual({ swept: false, pruned: 0 });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(listSpy).toHaveBeenCalledTimes(2);
    } finally {
      listSpy.mockRestore();
    }
  });

  it("preserves pending media with one snapshot for orphaned continuations", async () => {
    const keptKey = "agent:main:cron:job1:run:kept";
    const prunedKey = "agent:main:cron:job1:run:pruned";
    const kept = expiredRun("kept", {
      delivery: { kind: "none" },
      cronRunContinuation: {
        lifecycleRevision: "revision-1",
        phase: "continuing",
        ownerRunId: "dead-gateway-run",
        basePersisted: false,
      },
    });
    await seedSessionEntries(storePath, {
      [keptKey]: kept,
      [prunedKey]: { ...kept, sessionId: "pruned" },
    });
    mediaGeneration.registerGeneratedMediaTaskActivity("kept-media", keptKey, "main");
    expect(await sweep(now)).toEqual({
      swept: true,
      pruned: 1,
    });
    expect(buildPendingSet).toHaveBeenCalledOnce();
    expect(log.warn).not.toHaveBeenCalled();
    expect(readSessionEntries(storePath)).toEqual({ [keptKey]: kept });
  });
});
