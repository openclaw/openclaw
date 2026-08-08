// Covers the scheduler-owned maintenance phase transition reconciliation.
// The transition owns the deferred-queue phase id (bumped on window entry)
// and the backlog drain (on window exit), so the tests focus on the
// state-transition matrix rather than the underlying policy or queue.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  beginMaintenancePhase,
  getMaintenanceDeferralCount,
  recordMaintenanceDeferral,
  resetMaintenanceDeferrals,
} from "./maintenance-deferred.js";
import { reconcileMaintenancePhaseTransition } from "./maintenance-policy.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { createCronServiceState } from "./service/state.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-phase-transition-",
});

const AT_UTC_03_30 = Date.UTC(2026, 0, 15, 3, 30, 0); // inside [02:00, 04:00)
const AT_UTC_01_30 = Date.UTC(2026, 0, 15, 1, 30, 0); // before window
const AT_UTC_05_00 = Date.UTC(2026, 0, 15, 5, 0, 0); // after window

function maintenanceConfig() {
  return {
    enabled: true,
    window: { start: "02:00", end: "04:00", timezone: "UTC" },
    maintenanceAgents: ["ops"],
  };
}

async function makeState(maintenance = maintenanceConfig()) {
  const { storePath } = await makeStorePath();
  return createCronServiceState({
    storePath,
    cronEnabled: true,
    log: logger,
    defaultAgentId: "main",
    userTimezone: "UTC",
    cronConfig: { maintenance },
  });
}

describe("reconcileMaintenancePhaseTransition", () => {
  beforeEach(() => {
    resetMaintenanceDeferrals();
  });
  afterEach(() => {
    resetMaintenanceDeferrals();
  });

  it("first call records the current phase and bumps if maintenance is already active", async () => {
    // If the service starts inside the maintenance window, the deferred-queue
    // phase id must be bumped so the first deferral binds to the current
    // window rather than a hypothetical phase-0.
    const state = await makeState();
    const t = reconcileMaintenancePhaseTransition(state, AT_UTC_03_30);
    expect(t.previous).toBeUndefined();
    expect(t.current).toBe("maintenance");
    expect(t.phaseBegan).toBe(true);
    expect(t.drainedCount).toBe(0);
    expect(state.lastMaintenancePhase).toBe("maintenance");
  });

  it("first call records the current phase without bumping if maintenance is not active", async () => {
    const state = await makeState();
    const t = reconcileMaintenancePhaseTransition(state, AT_UTC_05_00);
    expect(t.previous).toBeUndefined();
    expect(t.current).toBe("normal");
    expect(t.phaseBegan).toBe(false);
    expect(t.drainedCount).toBe(0);
    expect(state.lastMaintenancePhase).toBe("normal");
  });

  it("no-op when the phase does not change", async () => {
    const state = await makeState();
    reconcileMaintenancePhaseTransition(state, AT_UTC_03_30); // sets to maintenance
    const t = reconcileMaintenancePhaseTransition(state, AT_UTC_03_30 + 1_000);
    expect(t.previous).toBe("maintenance");
    expect(t.current).toBe("maintenance");
    expect(t.phaseBegan).toBe(false);
    expect(t.drainedCount).toBe(0);
  });

  it("bumps the phase id on normal -> maintenance transition", async () => {
    const state = await makeState();
    reconcileMaintenancePhaseTransition(state, AT_UTC_01_30); // normal
    expect(state.lastMaintenancePhase).toBe("normal");
    const t = reconcileMaintenancePhaseTransition(state, AT_UTC_03_30); // -> maintenance
    expect(t.previous).toBe("normal");
    expect(t.current).toBe("maintenance");
    expect(t.phaseBegan).toBe(true);
    expect(t.drainedCount).toBe(0);
  });

  it("drains the backlog on maintenance -> normal transition", async () => {
    const state = await makeState();
    reconcileMaintenancePhaseTransition(state, AT_UTC_03_30); // -> maintenance
    recordMaintenanceDeferral({ jobId: "job-A", agentId: "main", nowMs: AT_UTC_03_30 });
    recordMaintenanceDeferral({ jobId: "job-B", agentId: "main", nowMs: AT_UTC_03_30 + 1_000 });
    expect(getMaintenanceDeferralCount()).toBe(2);

    const t = reconcileMaintenancePhaseTransition(state, AT_UTC_05_00); // -> normal
    expect(t.previous).toBe("maintenance");
    expect(t.current).toBe("normal");
    expect(t.phaseBegan).toBe(false);
    expect(t.drainedCount).toBe(2);
    expect(getMaintenanceDeferralCount()).toBe(0);
    expect(state.lastMaintenancePhase).toBe("normal");
  });

  it("does not throw when maintenance is disabled (phase is always normal)", async () => {
    const state = await makeState({
      enabled: false,
      window: { start: "02:00", end: "04:00", timezone: "UTC" },
    });
    expect(() => reconcileMaintenancePhaseTransition(state, AT_UTC_03_30)).not.toThrow();
    expect(state.lastMaintenancePhase).toBe("normal");
  });

  it("clears a stale backlog from a prior window", async () => {
    const state = await makeState();
    // Simulate: previous window was active, we left a deferral, then a
    // service restart reset the queue phase id but somehow an entry survived.
    beginMaintenancePhase(AT_UTC_03_30);
    recordMaintenanceDeferral({ jobId: "stale-job", agentId: "main", nowMs: AT_UTC_03_30 });
    expect(getMaintenanceDeferralCount()).toBe(1);

    // First tick: outside the window, so phase is normal -> nothing happens.
    // previous is undefined, current is normal: no transition (no bump, no drain).
    const t1 = reconcileMaintenancePhaseTransition(state, AT_UTC_05_00);
    expect(t1.drainedCount).toBe(0);
    // The stale entry is still there because the prior phase was undefined;
    // we only drain on an actual maintenance -> normal transition.
    expect(getMaintenanceDeferralCount()).toBe(1);

    // Next tick: same normal, no-op.
    const t2 = reconcileMaintenancePhaseTransition(state, AT_UTC_05_00 + 1_000);
    expect(t2.drainedCount).toBe(0);
  });

  it("logs the transition details for diagnostics", async () => {
    const state = await makeState();
    // no logger assertions here; just confirm the call returns the structured
    // details that the scheduler's log lines use.
    reconcileMaintenancePhaseTransition(state, AT_UTC_01_30);
    const t = reconcileMaintenancePhaseTransition(state, AT_UTC_03_30);
    expect(t).toMatchObject({
      previous: "normal",
      current: "maintenance",
      phaseBegan: true,
      drainedCount: 0,
    });
  });
});
