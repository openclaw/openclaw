import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveStateDir } from "../config/paths.js";
import {
  listSessionEntriesCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import * as maintenance from "../config/sessions/session-entry-read-maintenance.js";
import { cronTestDeps, cronTestJob } from "./service.fixture-builders.test-support.js";
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
  return cronTestJob({
    id,
    deleteAfterRun: false,
    createdAtMs: baseNow,
    updatedAtMs: baseNow,
    delivery: { mode: "none" },
    state: { nextRunAtMs: baseNow },
  });
}

async function fixture(jobs: CronJob[] = [], deps: Partial<CronServiceDeps> = {}) {
  const store = await makeStorePath();
  const sessionStorePath = path.join(path.dirname(store.storePath), "sessions", "sessions.json");
  await saveCronStore(store.storePath, { version: 1, jobs });
  const state = createState(
    cronTestDeps({
      storePath: store.storePath,
      log,
      nowMs: () => baseNow,
      runIsolatedAgentJob: vi.fn(),
      defaultAgentId: "main",
      sessionStorePath,
      ...deps,
    }),
  );
  const readExpired = vi.spyOn(maintenance, "readExpiredCronRunEntriesInWorker");
  return {
    ...store,
    sessionStorePath,
    state,
    readExpired,
    async tick(reads: number, sessions: number) {
      await onTimer(state);
      expect(readExpired).toHaveBeenCalledTimes(reads);
      expect(entries(sessionStorePath)).toHaveLength(sessions);
    },
    [Symbol.asyncDispose]: () => withCronServiceStateForTest(state, async () => {}),
  };
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

  it("admits timer maintenance before checking availability, including re-enable", async () => {
    let now = baseNow;
    const isAgentAvailable = vi.fn(() => true);
    await using context = await fixture([], {
      nowMs: () => now,
      cronConfig: { sessionRetention: false },
      isAgentAvailable,
    });
    const { state, sessionStorePath } = context;
    await seedSessions(sessionStorePath);
    await onTimer(state);
    await context.tick(0, 2);
    expect(isAgentAvailable).not.toHaveBeenCalled();
    state.deps.cronConfig = { sessionRetention: "24h" };
    await context.tick(1, 1);
    expect(isAgentAvailable).toHaveBeenCalledExactlyOnceWith("main", { deletionBlocked: false });
    await seedSessions(sessionStorePath, now - 3_600_000);
    now += 1_000;
    await context.tick(1, 2);
    expect(isAgentAvailable).toHaveBeenCalledOnce();
  });

  it("runs a recovered agent's scheduled job while its maintenance attempt is throttled", async () => {
    let now = baseNow;
    let available = false;
    const runIsolatedAgentJob = vi.fn().mockResolvedValue({ status: "ok", summary: "done" });
    await using context = await fixture(
      [{ ...dueJob("recovered-agent"), agentId: "main", state: { nextRunAtMs: now + 1_000 } }],
      { nowMs: () => now, isAgentAvailable: () => available, runIsolatedAgentJob },
    );
    const { sessionStorePath } = context;
    await seedSessions(sessionStorePath);
    await context.tick(0, 2);
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    available = true;
    now += 1_000;
    await context.tick(0, 2);
    expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
    now += 5 * 60_000 - 1_000;
    await context.tick(1, 1);
  });

  it.each(["owner discovery", "store path"])(
    "keeps the scheduler running after reaper %s fails",
    async (failure) => {
      const runIsolatedAgentJob = vi.fn().mockResolvedValue({ status: "ok", summary: "done" });
      await using context = await fixture([dueJob("recover-reaper-store")], {
        runIsolatedAgentJob,
        resolveSessionStoreAgentIds: async () => {
          if (failure === "owner discovery") {
            throw new Error("session store temporarily unavailable");
          }
          return ["main"];
        },
        resolveSessionStorePath: () => {
          throw new Error("session store temporarily unavailable");
        },
      });
      const { state } = context;
      await expect(onTimer(state)).resolves.toBeUndefined();
      expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
      expect(log.warn).toHaveBeenCalled();
    },
  );

  it.each(["execution", "store load"])(
    "prunes expired sessions after a %s error",
    async (failureKind) => {
      const failure = new Error(
        failureKind === "execution" ? "gateway down" : "cron store unavailable",
      );
      const runIsolatedAgentJob =
        failureKind === "execution" ? vi.fn().mockRejectedValue(failure) : vi.fn();
      await using context = await fixture([dueJob("failing-job")], {
        runIsolatedAgentJob,
      });
      const { state, storePath, sessionStorePath } = context;
      const fresh = await seedSessions(sessionStorePath);
      if (failureKind === "store load") {
        await ensureLoaded(state);
        using loadSpy = vi.spyOn(cronStoreModule, "loadCronJobsStoreWithConfigJobsByKey");
        loadSpy.mockRejectedValueOnce(failure);
        await expect(onTimer(state)).rejects.toBe(failure);
        expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      } else {
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
      }
      expect(entries(sessionStorePath)).toEqual([fresh]);
    },
  );

  it("keeps shared-store reaper targets distinct and resolves the current default agent", async () => {
    await using context = await fixture(
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
    const { state, sessionStorePath } = context;
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
    await onTimer(state);
    expect([...new Set(resolvedAgentIds)].toSorted()).toEqual(["main", "worker"]);
    expect(entries(sessionStorePath)).toStrictEqual([]);
    expect(entries(sessionStorePath, "worker")).toStrictEqual([]);
  });

  it("skips an unavailable owner with unfinished job cleanup without hiding a live owner", async () => {
    const isAgentAvailable = vi.fn((agentId: string) => agentId === "live");
    await using context = await fixture(
      [{ ...dueJob("unfinished-cleanup"), agentId: "blocked", enabled: false }],
      {
        defaultAgentId: undefined,
        resolveDefaultAgentId: () => undefined,
        resolveSessionStoreAgentIds: async () => ["live", "blocked"],
        isAgentAvailable,
      },
    );
    const { state, sessionStorePath } = context;
    state.deps.resolveSessionStorePath = () => sessionStorePath;
    await seedExpired(sessionStorePath, "live");
    await onTimer(state);
    await onTimer(state);
    expect(isAgentAvailable.mock.calls).toEqual([
      ["live", { deletionBlocked: false }],
      ["blocked", { deletionBlocked: false }],
    ]);
    expect(context.readExpired).toHaveBeenCalledExactlyOnceWith({
      agentId: "live",
      env: { OPENCLAW_STATE_DIR: resolveStateDir() },
      storePath: sessionStorePath,
      updatedBefore: baseNow - 24 * 3_600_000,
    });
    expect(entries(sessionStorePath, "live")).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
