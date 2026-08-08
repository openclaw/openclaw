// Covers the maintenance-window gate in `inspectManualRunPreflight`.
// The gate is at the head of every manual cron run; tests use a stub state to
// exercise both the admit and block paths without touching the durable store.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetMaintenanceDeferrals } from "../maintenance-deferred.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../service.test-harness.js";
import type { CronJob } from "../types.js";
import { inspectManualRunDisposition } from "./ops-run-preparation.js";
import { createCronServiceState } from "./state.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-prep-maintenance-",
});

const AT_UTC_03_30 = Date.UTC(2026, 0, 15, 3, 30, 0);

function makeJob(id: string, agentId: string): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: 0 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "hi", toolsAllow: ["write"] },
    agentId,
    state: {
      lastRunAtMs: 0,
      lastStatus: "ok",
      lastDurationMs: 0,
      consecutiveErrors: 0,
      // nextRunAtMs must be set so isJobDue returns true; the maintenance
      // gate is post-admission and only fires for work that would have run.
      nextRunAtMs: AT_UTC_03_30 - 1_000,
    },
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

type MaintenanceCfg = {
  enabled: boolean;
  window: { start: string; end: string; timezone: string };
  maintenanceAgents?: readonly string[];
  allowManualRun?: boolean;
};

async function makeState(params: {
  maintenance: MaintenanceCfg;
  userTimezone?: string;
  job?: CronJob;
}) {
  const { storePath } = await makeStorePath();
  const job = params.job ?? makeJob("job-A", "main");
  await writeCronStoreSnapshot({ storePath, jobs: [job] });
  const state = createCronServiceState({
    storePath,
    cronEnabled: true,
    log: logger,
    nowMs: () => AT_UTC_03_30,
    enqueueSystemEvent: () => undefined,
    requestHeartbeat: () => undefined,
    runIsolatedAgentJob: (() => {
      throw new Error("cron: job execution timed out");
    }) as never,
    cronConfig: { maintenance: params.maintenance },
    userTimezone: params.userTimezone,
  });
  return { state, job };
}

describe("inspectManualRunPreflight maintenance gate", () => {
  beforeEach(() => {
    resetMaintenanceDeferrals();
  });
  afterEach(() => {
    resetMaintenanceDeferrals();
  });

  it("admits manual run in normal phase", async () => {
    const { state } = await makeState({
      maintenance: {
        enabled: true,
        window: { start: "04:00", end: "06:00", timezone: "UTC" },
      },
      userTimezone: "UTC",
    });
    const result = await inspectManualRunDisposition(state, "job-A", "due");
    expect(result.ok).toBe(true);
    if (result.ok && "runnable" in result) {
      expect(result.runnable).toBe(true);
    }
  });

  it("blocks manual run when maintenance is enabled and agent is not in roster", async () => {
    const { state } = await makeState({
      maintenance: {
        enabled: true,
        window: { start: "02:00", end: "04:00", timezone: "UTC" },
        maintenanceAgents: ["ops"],
      },
      userTimezone: "UTC",
    });
    const result = await inspectManualRunDisposition(state, "job-A", "due");
    expect(result.ok).toBe(true);
    if (result.ok && "reason" in result) {
      expect(result.reason).toBe("maintenance-blocked");
    }
  });

  it("admits manual run when agent is in maintenance roster", async () => {
    const { state } = await makeState({
      maintenance: {
        enabled: true,
        window: { start: "02:00", end: "04:00", timezone: "UTC" },
        maintenanceAgents: ["ops"],
      },
      userTimezone: "UTC",
      job: makeJob("job-ops", "ops"),
    });
    const result = await inspectManualRunDisposition(state, "job-ops", "due");
    expect(result.ok).toBe(true);
    if (result.ok && "runnable" in result) {
      expect(result.runnable).toBe(true);
    }
  });

  it("'force' mode pierces the maintenance gate", async () => {
    const { state } = await makeState({
      maintenance: {
        enabled: true,
        window: { start: "02:00", end: "04:00", timezone: "UTC" },
        maintenanceAgents: ["ops"],
      },
      userTimezone: "UTC",
    });
    const result = await inspectManualRunDisposition(state, "job-A", "force");
    expect(result.ok).toBe(true);
    if (result.ok && "runnable" in result) {
      expect(result.runnable).toBe(true);
    }
  });

  it("allowManualRun: true admits any agent in maintenance", async () => {
    const { state } = await makeState({
      maintenance: {
        enabled: true,
        window: { start: "02:00", end: "04:00", timezone: "UTC" },
        maintenanceAgents: ["ops"],
        allowManualRun: true,
      },
      userTimezone: "UTC",
    });
    const result = await inspectManualRunDisposition(state, "job-A", "due");
    expect(result.ok).toBe(true);
    if (result.ok && "runnable" in result) {
      expect(result.runnable).toBe(true);
    }
  });

  it("records the deferral when blocking a manual run", async () => {
    const { state } = await makeState({
      maintenance: {
        enabled: true,
        window: { start: "02:00", end: "04:00", timezone: "UTC" },
        maintenanceAgents: ["ops"],
      },
      userTimezone: "UTC",
    });
    await inspectManualRunDisposition(state, "job-A", "due");
    await inspectManualRunDisposition(state, "job-A", "due");
    const result = await inspectManualRunDisposition(state, "job-A", "due");
    expect(result.ok).toBe(true);
    if (result.ok && "reason" in result) {
      expect(result.reason).toBe("maintenance-blocked");
    }
  });

  it("does not block when maintenance.enabled is false", async () => {
    const { state } = await makeState({
      maintenance: {
        enabled: false,
        window: { start: "02:00", end: "04:00", timezone: "UTC" },
      },
      userTimezone: "UTC",
    });
    const result = await inspectManualRunDisposition(state, "job-A", "due");
    expect(result.ok).toBe(true);
    if (result.ok && "runnable" in result) {
      expect(result.runnable).toBe(true);
    }
  });

  it("returns not-due (not maintenance-blocked) for a not-yet-due job inside the window", async () => {
    // Regression for ClawSweeper cycle 4 [P2] "Check manual due
    // eligibility before recording a deferral". A `mode: "due"` request
    // for a future-dated job must short-circuit on isJobDue BEFORE
    // recording a maintenance deferral, so the backlog only contains
    // work that would have actually run.
    const { state } = await makeState({
      maintenance: {
        enabled: true,
        window: { start: "02:00", end: "04:00", timezone: "UTC" },
        maintenanceAgents: ["ops"], // main is NOT in roster
      },
      userTimezone: "UTC",
      job: {
        ...makeJob("job-A", "main"),
        state: {
          lastRunAtMs: 0,
          lastStatus: "ok",
          lastDurationMs: 0,
          consecutiveErrors: 0,
          // nextRunAtMs is 1 hour in the future, so isJobDue returns false.
          nextRunAtMs: AT_UTC_03_30 + 60 * 60_000,
        },
      },
    });
    const result = await inspectManualRunDisposition(state, "job-A", "due");
    expect(result.ok).toBe(true);
    if (result.ok && "reason" in result) {
      expect(result.reason).toBe("not-due");
    }
    // And — critically — no deferral was recorded, so the backlog is
    // empty. The previous design recorded a deferral even for not-yet-due
    // jobs, polluting the diagnostics.
    const { getMaintenanceDeferralCount } = await import("../maintenance-deferred.js");
    expect(getMaintenanceDeferralCount()).toBe(0);
  });
});
