import { describe, expect, it } from "vitest";
import type { CronServiceState } from "./service/state.js";
import type { CronJob, CronJobPatch } from "./types.js";
import { applyJobPatch, recomputeNextRuns } from "./service/jobs.js";

function makeFakeState(jobs: CronJob[], nowMs: number): CronServiceState {
  return {
    deps: {
      nowMs: () => nowMs,
      log: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      storePath: "/tmp/test-cron.json",
      cronEnabled: true,
      enqueueSystemEvent: () => {},
      requestHeartbeatNow: () => {},
      runIsolatedAgentJob: async () => ({ status: "ok" }),
    },
    store: { version: 1, jobs },
    timer: null,
    running: false,
    op: Promise.resolve(),
    warnedDisabled: false,
    storeLoadedAtMs: nowMs,
    storeFileMtimeMs: null,
  };
}

function makeEveryJob(opts: {
  id: string;
  everyMs: number;
  anchorMs?: number;
  nextRunAtMs?: number;
  enabled?: boolean;
}): CronJob {
  const now = Date.now();
  return {
    id: opts.id,
    name: opts.id,
    enabled: opts.enabled ?? true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: {
      kind: "every",
      everyMs: opts.everyMs,
      ...(opts.anchorMs != null ? { anchorMs: opts.anchorMs } : {}),
    },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "ping" },
    state: {
      ...(opts.nextRunAtMs != null ? { nextRunAtMs: opts.nextRunAtMs } : {}),
    },
  };
}

describe("recomputeNextRuns", () => {
  it("preserves existing nextRunAtMs (does not push due jobs into the future)", () => {
    // Simulate: timer fires at T=300_000. The job was scheduled at T=300_000.
    // recomputeNextRuns is called (inside ensureLoaded forceReload).
    // BUG (before fix): nextRunAtMs gets reset to now+interval = 600_000.
    // FIX: nextRunAtMs stays at 300_000 so runDueJobs sees it as due.
    const T = 300_000;
    const interval = 300_000; // 5 minutes
    const job = makeEveryJob({
      id: "hb",
      everyMs: interval,
      nextRunAtMs: T, // due NOW
    });
    const state = makeFakeState([job], T);

    recomputeNextRuns(state);

    // Must NOT have changed to T + interval
    expect(job.state.nextRunAtMs).toBe(T);
  });

  it("computes nextRunAtMs when it is missing", () => {
    const now = 1_000_000;
    const interval = 60_000;
    const job = makeEveryJob({ id: "new", everyMs: interval });
    // nextRunAtMs is undefined (fresh job)
    expect(job.state.nextRunAtMs).toBeUndefined();

    const state = makeFakeState([job], now);
    recomputeNextRuns(state);

    // Should now be set to something in the future
    expect(typeof job.state.nextRunAtMs).toBe("number");
    expect(job.state.nextRunAtMs).toBeGreaterThan(now);
  });

  it("preserves past-due nextRunAtMs so runDueJobs fires them", () => {
    // Gateway was down. Job was due 10 minutes ago.
    const now = 1_000_000;
    const pastDue = now - 600_000; // 10 min ago
    const job = makeEveryJob({ id: "overdue", everyMs: 300_000, nextRunAtMs: pastDue });
    const state = makeFakeState([job], now);

    recomputeNextRuns(state);

    // Past-due value must be preserved (not pushed to now + interval)
    expect(job.state.nextRunAtMs).toBe(pastDue);
  });

  it("clears nextRunAtMs for disabled jobs", () => {
    const job = makeEveryJob({
      id: "disabled",
      everyMs: 60_000,
      nextRunAtMs: 999_999,
      enabled: false,
    });
    const state = makeFakeState([job], Date.now());

    recomputeNextRuns(state);

    expect(job.state.nextRunAtMs).toBeUndefined();
  });
});

describe("applyJobPatch", () => {
  it("clears delivery when switching to main session", () => {
    const now = Date.now();
    const job: CronJob = {
      id: "job-1",
      name: "job-1",
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "do it" },
      delivery: { mode: "announce", channel: "telegram", to: "123" },
      state: {},
    };

    const patch: CronJobPatch = {
      sessionTarget: "main",
      payload: { kind: "systemEvent", text: "ping" },
    };

    expect(() => applyJobPatch(job, patch)).not.toThrow();
    expect(job.sessionTarget).toBe("main");
    expect(job.payload.kind).toBe("systemEvent");
    expect(job.delivery).toBeUndefined();
  });

  it("maps legacy payload delivery updates onto delivery", () => {
    const now = Date.now();
    const job: CronJob = {
      id: "job-2",
      name: "job-2",
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "do it" },
      delivery: { mode: "announce", channel: "telegram", to: "123" },
      state: {},
    };

    const patch: CronJobPatch = {
      payload: {
        kind: "agentTurn",
        deliver: false,
        channel: "Signal",
        to: "555",
        bestEffortDeliver: true,
      },
    };

    expect(() => applyJobPatch(job, patch)).not.toThrow();
    expect(job.payload.kind).toBe("agentTurn");
    if (job.payload.kind === "agentTurn") {
      expect(job.payload.deliver).toBe(false);
      expect(job.payload.channel).toBe("Signal");
      expect(job.payload.to).toBe("555");
      expect(job.payload.bestEffortDeliver).toBe(true);
    }
    expect(job.delivery).toEqual({
      mode: "none",
      channel: "signal",
      to: "555",
      bestEffort: true,
    });
  });

  it("treats legacy payload targets as announce requests", () => {
    const now = Date.now();
    const job: CronJob = {
      id: "job-3",
      name: "job-3",
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "do it" },
      delivery: { mode: "none", channel: "telegram" },
      state: {},
    };

    const patch: CronJobPatch = {
      payload: { kind: "agentTurn", to: " 999 " },
    };

    expect(() => applyJobPatch(job, patch)).not.toThrow();
    expect(job.delivery).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "999",
      bestEffort: undefined,
    });
  });
});
