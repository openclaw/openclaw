// TDD coverage for cron.maintenance.* config changes.
//
// The cron service state holds \`deps.cronConfig\` at construction time. When
// the gateway hot-reload planner detects a maintenance-block change, it
// rebuilds the cron service via \`buildGatewayCronService({cfg: nextConfig, ...})\`.
// This test exercises the contract: a freshly-constructed state with a new
// \`cronConfig\` reflects the new config immediately, and the
// \`reconcileMaintenancePhaseTransition\` helper (which the scheduler tick
// calls) treats the post-rebuild tick as a transition from undefined.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetMaintenanceDeferrals } from "./maintenance-deferred.js";
import {
  reconcileMaintenancePhaseTransition,
  resolveMaintenancePhase,
} from "./maintenance-policy.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { createCronServiceState } from "./service/state.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-hot-reload-",
});

const AT_UTC_03_30 = Date.UTC(2026, 0, 15, 3, 30, 0); // inside [02:00, 04:00)

async function makeStateWithMaintenance(
  maintenance:
    | {
        enabled: true;
        window: { start: string; end: string; timezone: string };
        maintenanceAgents?: readonly string[];
        allowManualRun?: boolean;
      }
    | undefined,
  userTimezone = "UTC",
) {
  const { storePath } = await makeStorePath();
  return createCronServiceState({
    storePath,
    cronEnabled: true,
    log: logger,
    defaultAgentId: "main",
    userTimezone,
    cronConfig: maintenance === undefined ? {} : { maintenance },
  });
}

beforeEach(() => {
  resetMaintenanceDeferrals();
});
afterEach(() => {
  resetMaintenanceDeferrals();
});

describe("cron.maintenance.* hot reload", () => {
  it("a fresh state with no maintenance block returns normal for every agent", async () => {
    const state = await makeStateWithMaintenance(undefined);
    const result = resolveMaintenancePhase({
      cfg: {
        agents: { defaults: { userTimezone: "UTC" } },
        cron: {},
      },
      nowMs: AT_UTC_03_30,
      agentId: "main",
    });
    expect(result.phase).toBe("normal");
    expect(result.allowed).toBe(true);
    // The scheduler-owned phase transition is a no-op when the maintenance
    // block is absent: undefined -> normal, no bump, no drain.
    const transition = reconcileMaintenancePhaseTransition(state, AT_UTC_03_30);
    expect(transition.current).toBe("normal");
    expect(transition.phaseBegan).toBe(false);
    expect(transition.drainedCount).toBe(0);
  });

  it("a fresh state with a maintenance block picks up the new config immediately", async () => {
    // The gateway hot-reload planner rebuilds the cron service when
    // cron.maintenance changes; this simulates one rebuild tick. The
    // first scheduler tick after the rebuild must see phase=maintenance
    // for a non-roster agent and bump the phase id.
    const state = await makeStateWithMaintenance({
      enabled: true,
      window: { start: "02:00", end: "04:00", timezone: "UTC" },
      maintenanceAgents: ["ops"],
    });
    const result = resolveMaintenancePhase({
      cfg: {
        agents: { defaults: { userTimezone: "UTC" } },
        cron: {
          maintenance: {
            enabled: true,
            window: { start: "02:00", end: "04:00", timezone: "UTC" },
            maintenanceAgents: ["ops"],
          },
        },
      },
      nowMs: AT_UTC_03_30,
      agentId: "main",
    });
    expect(result.phase).toBe("maintenance");
    expect(result.allowed).toBe(false);
    const transition = reconcileMaintenancePhaseTransition(state, AT_UTC_03_30);
    expect(transition.phaseBegan).toBe(true);
  });

  it("post-rebuild tick: maintenance active at rebuild time bumps the phase id", async () => {
    // After a rebuild while inside the maintenance window, the first tick
    // should see undefined -> maintenance and bump the phase id. This
    // protects against a stale phase id carrying over from a previous
    // service lifetime.
    const state = await makeStateWithMaintenance({
      enabled: true,
      window: { start: "02:00", end: "04:00", timezone: "UTC" },
      maintenanceAgents: ["ops"],
    });
    expect(state.lastMaintenancePhase).toBeUndefined();
    const transition = reconcileMaintenancePhaseTransition(state, AT_UTC_03_30);
    expect(transition.previous).toBeUndefined();
    expect(transition.current).toBe("maintenance");
    expect(transition.phaseBegan).toBe(true);
    expect(state.lastMaintenancePhase).toBe("maintenance");
  });

  it("post-rebuild tick: maintenance inactive at rebuild time is a no-op", async () => {
    const state = await makeStateWithMaintenance({
      enabled: true,
      window: { start: "02:00", end: "04:00", timezone: "UTC" },
      maintenanceAgents: ["ops"],
    });
    // 01:30 UTC == 01:30 wall clock UTC, before the 02:00-04:00 window.
    const beforeWindowUtc = AT_UTC_03_30 - 2 * 60 * 60_000;
    const transition = reconcileMaintenancePhaseTransition(state, beforeWindowUtc);
    expect(transition.previous).toBeUndefined();
    expect(transition.current).toBe("normal");
    expect(transition.phaseBegan).toBe(false);
  });

  it("changes to maintenanceAgents take effect after rebuild (roster semantics)", async () => {
    // Before: roster is ['ops']. After: roster is ['main']. The role
    // decision for the 'main' agent should flip from blocked to allowed
    // after the rebuild.
    const beforeState = await makeStateWithMaintenance({
      enabled: true,
      window: { start: "02:00", end: "04:00", timezone: "UTC" },
      maintenanceAgents: ["ops"],
    });
    const beforeResult = resolveMaintenancePhase({
      cfg: {
        agents: { defaults: { userTimezone: "UTC" } },
        cron: {
          maintenance: {
            enabled: true,
            window: { start: "02:00", end: "04:00", timezone: "UTC" },
            maintenanceAgents: ["ops"],
          },
        },
      },
      nowMs: AT_UTC_03_30,
      agentId: "main",
    });
    expect(beforeResult.allowed).toBe(false);

    const afterState = await makeStateWithMaintenance({
      enabled: true,
      window: { start: "02:00", end: "04:00", timezone: "UTC" },
      maintenanceAgents: ["main"],
    });
    const afterResult = resolveMaintenancePhase({
      cfg: {
        agents: { defaults: { userTimezone: "UTC" } },
        cron: {
          maintenance: {
            enabled: true,
            window: { start: "02:00", end: "04:00", timezone: "UTC" },
            maintenanceAgents: ["main"],
          },
        },
      },
      nowMs: AT_UTC_03_30,
      agentId: "main",
    });
    expect(afterResult.allowed).toBe(true);

    // The two states are independent (separate service instances).
    expect(beforeState.deps.cronConfig?.maintenance?.maintenanceAgents).toEqual(["ops"]);
    expect(afterState.deps.cronConfig?.maintenance?.maintenanceAgents).toEqual(["main"]);
  });

  it("changes to the window take effect after rebuild (different active hours)", async () => {
    // Before: window 02:00-04:00 (active at 03:30). After: window
    // 14:00-16:00 (inactive at 03:30). The phase decision should flip.
    const beforeState = await makeStateWithMaintenance({
      enabled: true,
      window: { start: "02:00", end: "04:00", timezone: "UTC" },
      maintenanceAgents: ["ops"],
    });
    const beforeResult = resolveMaintenancePhase({
      cfg: {
        agents: { defaults: { userTimezone: "UTC" } },
        cron: {
          maintenance: {
            enabled: true,
            window: { start: "02:00", end: "04:00", timezone: "UTC" },
            maintenanceAgents: ["ops"],
          },
        },
      },
      nowMs: AT_UTC_03_30,
      agentId: "main",
    });
    expect(beforeResult.phase).toBe("maintenance");
    // The state-level transition also fires for the before state.
    const beforeTransition = reconcileMaintenancePhaseTransition(beforeState, AT_UTC_03_30);
    expect(beforeTransition.phaseBegan).toBe(true);

    const afterState = await makeStateWithMaintenance({
      enabled: true,
      window: { start: "14:00", end: "16:00", timezone: "UTC" },
      maintenanceAgents: ["ops"],
    });
    const afterResult = resolveMaintenancePhase({
      cfg: {
        agents: { defaults: { userTimezone: "UTC" } },
        cron: {
          maintenance: {
            enabled: true,
            window: { start: "14:00", end: "16:00", timezone: "UTC" },
            maintenanceAgents: ["ops"],
          },
        },
      },
      nowMs: AT_UTC_03_30,
      agentId: "main",
    });
    expect(afterResult.phase).toBe("normal");
    // The after state's first tick at 03:30 (outside the new window) is a no-op.
    const afterTransition = reconcileMaintenancePhaseTransition(afterState, AT_UTC_03_30);
    expect(afterTransition.phaseBegan).toBe(false);
    expect(afterTransition.drainedCount).toBe(0);
  });
});
