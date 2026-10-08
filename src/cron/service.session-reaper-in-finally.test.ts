import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveStateDir } from "../config/paths.js";
import {
  listSessionEntriesCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import * as sessionEntryReadRuntime from "../config/sessions/session-entry-read-runtime.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createSessionReaperTimerHarness } from "./service.session-reaper.test-support.js";
import {
  createNoopLogger,
  createCronStoreHarness,
  withCronServiceStateForTest,
} from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";
import { ensureLoaded } from "./service/store.js";
import { resetReaperThrottle } from "./session-reaper.test-support.js";
import * as cronStoreModule from "./store.js";
import { loadCronStore, saveCronStore } from "./store.js";
import type { CronJob } from "./types.js";

const { createState, onTimer } = createSessionReaperTimerHarness();
const log = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-reaper-finally-" });
let baseNow = 0;

function dueJob(id: string): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    deleteAfterRun: false,
    createdAtMs: baseNow,
    updatedAtMs: baseNow,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "test" },
    delivery: { mode: "none" },
    state: { nextRunAtMs: baseNow },
  };
}

async function fixture(jobs: CronJob[] = [], deps: Partial<CronServiceDeps> = {}) {
  const store = await makeStorePath();
  const sessionStorePath = path.join(path.dirname(store.storePath), "sessions", "sessions.json");
  await saveCronStore(store.storePath, { version: 1, jobs });
  const state = createState({
    scheduler: createTestGatewayScheduler(),
    storePath: store.storePath,
    cronEnabled: true,
    log,
    nowMs: () => baseNow,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(),
    defaultAgentId: "main",
    sessionStorePath,
    ...deps,
  });
  return { ...store, sessionStorePath, state };
}

function entries(storePath: string, agentId = "main") {
  return listSessionEntriesCore({ agentId, storePath });
}

async function seedExpired(storePath: string, agentId = "main", now = baseNow) {
  await replaceSessionEntry(
    { agentId, storePath, sessionKey: `agent:${agentId}:cron:failing-job:run:stale` },
    { sessionId: `${agentId}-stale`, updatedAt: now - 25 * 3_600_000 },
  );
}

async function seedSessions(storePath: string, now = baseNow) {
  const fresh = {
    sessionKey: "agent:main:cron:failing-job:run:fresh",
    entry: { sessionId: "fresh-run", updatedAt: now, delivery: { kind: "none" as const } },
  };
  await seedExpired(storePath, "main", now);
  await replaceSessionEntry(
    { agentId: "main", storePath, sessionKey: fresh.sessionKey },
    fresh.entry,
  );
  expect(entries(storePath)).toHaveLength(2);
  return fresh;
}

describe("CronService - session reaper runs in finally block (#31946)", () => {
  beforeEach(() => {
    // Session maintenance workers use real time; only timer wakeups are fake.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    baseNow = Date.now();
    vi.clearAllMocks();
    resetReaperThrottle();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("admits timer maintenance before checking availability, including re-enable and rollback", async () => {
    let now = baseNow;
    const isAgentAvailable = vi.fn(() => true);
    const { state, sessionStorePath } = await fixture([], {
      nowMs: () => now,
      cronConfig: { sessionRetention: false },
      isAgentAvailable,
    });
    await seedSessions(sessionStorePath);
    const readExpired = vi.spyOn(sessionEntryReadRuntime, "readExpiredCronRunEntriesInWorker");
    await withCronServiceStateForTest(state, async () => {
      await onTimer(state);
      await onTimer(state);
      expect(isAgentAvailable).not.toHaveBeenCalled();
      expect(readExpired).not.toHaveBeenCalled();
      state.deps.cronConfig = { sessionRetention: "24h" };
      await onTimer(state);
      expect(isAgentAvailable).toHaveBeenCalledExactlyOnceWith("main");
      expect(readExpired).toHaveBeenCalledOnce();
      expect(entries(sessionStorePath)).toHaveLength(1);
      await seedSessions(sessionStorePath, now - 3_600_000);
      now += 1_000;
      await onTimer(state);
      expect(isAgentAvailable).toHaveBeenCalledOnce();
      expect(readExpired).toHaveBeenCalledOnce();
      expect(entries(sessionStorePath)).toHaveLength(2);
      now -= 3_600_000;
      await onTimer(state);
      expect(isAgentAvailable).toHaveBeenCalledTimes(2);
      expect(readExpired).toHaveBeenCalledTimes(2);
      expect(entries(sessionStorePath)).toHaveLength(1);
    });
  });

  it("runs a recovered agent's scheduled job while its maintenance attempt is throttled", async () => {
    let now = baseNow;
    let available = false;
    const runIsolatedAgentJob = vi.fn().mockResolvedValue({ status: "ok", summary: "done" });
    const { state, sessionStorePath } = await fixture(
      [{ ...dueJob("recovered-agent"), agentId: "main", state: { nextRunAtMs: now + 1_000 } }],
      { nowMs: () => now, isAgentAvailable: () => available, runIsolatedAgentJob },
    );
    await seedSessions(sessionStorePath);
    const readExpired = vi.spyOn(sessionEntryReadRuntime, "readExpiredCronRunEntriesInWorker");
    await withCronServiceStateForTest(state, async () => {
      await onTimer(state);
      expect(readExpired).not.toHaveBeenCalled();
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      available = true;
      now += 1_000;
      await onTimer(state);
      expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
      expect(readExpired).not.toHaveBeenCalled();
      expect(entries(sessionStorePath)).toHaveLength(2);
      now += 5 * 60_000 - 1_000;
      await onTimer(state);
      expect(readExpired).toHaveBeenCalledOnce();
      expect(entries(sessionStorePath)).toHaveLength(1);
    });
  });

  it("runs explicit-agent jobs when no default reaper agent exists", async () => {
    const job = { ...dueJob("explicit-agent"), agentId: "worker" };
    const runIsolatedAgentJob = vi.fn().mockResolvedValue({ status: "ok", summary: "done" });
    const { state, sessionStorePath } = await fixture([job], {
      runIsolatedAgentJob,
      defaultAgentId: undefined,
      resolveDefaultAgentId: () => undefined,
      resolveSessionStoreAgentIds: () => ["worker"],
    });
    await seedExpired(sessionStorePath, "worker");
    state.store = { version: 1, jobs: [job] };
    await withCronServiceStateForTest(state, async () => {
      await expect(onTimer(state)).resolves.toBeUndefined();
      expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
      expect(entries(sessionStorePath, "worker")).toStrictEqual([]);
      expect(state.running).toBe(false);
      expect(state.timer).not.toBeNull();
    });
  });

  it("keeps the scheduler running after reaper session-store resolution fails", async () => {
    const runIsolatedAgentJob = vi.fn().mockResolvedValue({ status: "ok", summary: "done" });
    const { state } = await fixture([dueJob("recover-reaper-store")], {
      runIsolatedAgentJob,
      resolveSessionStoreAgentIds: () => ["main"],
      resolveSessionStorePath: () => {
        throw new Error("session store temporarily unavailable");
      },
    });
    await withCronServiceStateForTest(state, async () => {
      await expect(onTimer(state)).resolves.toBeUndefined();
      expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
      expect(state.running).toBe(false);
      expect(state.timer).not.toBeNull();
      expect(log.warn).toHaveBeenCalled();
    });
  });

  it("prunes expired run sessions after a job execution error", async () => {
    const runIsolatedAgentJob = vi.fn().mockRejectedValue(new Error("gateway down"));
    const { state, storePath, sessionStorePath } = await fixture([dueJob("failing-job")], {
      runIsolatedAgentJob,
    });
    const fresh = await seedSessions(sessionStorePath);
    await withCronServiceStateForTest(state, async () => {
      await onTimer(state);
      expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
      expect(log.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("cron: job core rejected after"),
      );
      expect((await loadCronStore(storePath)).jobs[0]?.state).toMatchObject({
        lastRunStatus: "error",
        lastError: "gateway down",
      });
      expect(entries(sessionStorePath)).toEqual([fresh]);
      expect(state.running).toBe(false);
      expect(state.timer).not.toBeNull();
    });
  });

  it("prunes expired run sessions while propagating a cron store load failure", async () => {
    const { state, sessionStorePath } = await fixture([dueJob("failing-job")]);
    const fresh = await seedSessions(sessionStorePath);
    await withCronServiceStateForTest(state, async () => {
      await ensureLoaded(state);
      const failure = new Error("cron store unavailable");
      const loadSpy = vi
        .spyOn(cronStoreModule, "loadCronJobsStoreWithConfigJobs")
        .mockRejectedValueOnce(failure);
      try {
        await expect(onTimer(state)).rejects.toBe(failure);
        expect(state.deps.runIsolatedAgentJob).not.toHaveBeenCalled();
        expect(entries(sessionStorePath)).toEqual([fresh]);
        expect(state.running).toBe(false);
        expect(state.timer).not.toBeNull();
      } finally {
        loadSpy.mockRestore();
      }
    });
  });

  it("keeps shared-store reaper targets distinct and resolves the current default agent", async () => {
    const { state, sessionStorePath } = await fixture(
      [
        dueJob("default-job"),
        {
          ...dueJob("worker-job"),
          enabled: false,
          sessionKey: "agent:worker:main",
          sessionTarget: "main",
          payload: { kind: "systemEvent", text: "worker task" },
        },
      ],
      {
        defaultAgentId: "retired",
        resolveDefaultAgentId: () => "main",
        runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "done" }),
      },
    );
    for (const agentId of ["main", "worker"]) {
      await seedExpired(sessionStorePath, agentId);
    }
    const resolvedAgentIds: string[] = [];
    state.deps.resolveSessionStorePath = (agentId) => {
      if (!agentId) {
        throw new Error("expected prepared agent id");
      }
      resolvedAgentIds.push(agentId);
      return sessionStorePath;
    };
    await withCronServiceStateForTest(state, async () => {
      await onTimer(state);
      expect([...new Set(resolvedAgentIds)].toSorted()).toEqual(["main", "worker"]);
      expect(entries(sessionStorePath)).toStrictEqual([]);
      expect(entries(sessionStorePath, "worker")).toStrictEqual([]);
      expect(state.running).toBe(false);
    });
  });

  it("skips an unavailable owner with unfinished job cleanup without hiding a live owner", async () => {
    const isAgentAvailable = vi.fn((agentId: string) => agentId === "live");
    const { state, sessionStorePath } = await fixture(
      [{ ...dueJob("unfinished-cleanup"), agentId: "blocked", enabled: false }],
      {
        defaultAgentId: undefined,
        resolveDefaultAgentId: () => undefined,
        resolveSessionStoreAgentIds: () => ["live", "blocked"],
        isAgentAvailable,
      },
    );
    state.deps.resolveSessionStorePath = () => sessionStorePath;
    await seedExpired(sessionStorePath, "live");
    const readExpired = vi.spyOn(sessionEntryReadRuntime, "readExpiredCronRunEntriesInWorker");
    await withCronServiceStateForTest(state, async () => {
      await onTimer(state);
      await onTimer(state);
      expect(isAgentAvailable.mock.calls).toEqual([["live"], ["blocked"]]);
      expect(readExpired).toHaveBeenCalledExactlyOnceWith({
        agentId: "live",
        env: { OPENCLAW_STATE_DIR: resolveStateDir() },
        storePath: sessionStorePath,
        updatedBefore: baseNow - 24 * 3_600_000,
      });
      expect(entries(sessionStorePath, "live")).toEqual([]);
      expect(log.warn).not.toHaveBeenCalled();
    });
  });
});
