// Regression for ClawSweeper cycle 4 [P1] "Clear deferred state when
// replacing the cron service". The maintenance deferred queue is a
// process-global singleton. When the gateway hot-reloads the cron
// subsystem (e.g. after a config change that flips `plan.restartCron`),
// the new service instance must NOT inherit the previous instance's
// held-backlog. Otherwise a job deferred by the old service would
// silently hang in the queue with no scheduler tick to replay it.
//
// This test exercises the contract by:
//   1. Building a cron service under a maintenance config (using the
//      real `buildGatewayCronService` and a stub gateway runtime).
//   2. Recording a deferral against the in-process queue.
//   3. Building a second cron service (simulating a hot-reload rebuild).
//   4. Verifying the queue is empty after the rebuild.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  beginMaintenancePhase,
  getMaintenanceDeferralCount,
  recordMaintenanceDeferral,
  resetMaintenanceDeferrals,
} from "../cron/maintenance-deferred.js";
import { buildGatewayCronService } from "./server-cron.js";

type RuntimeParams = ConstructorParameters<typeof buildGatewayCronService>[0];

function stubRuntime(overrides?: { userTimezone?: string }): RuntimeParams {
  // The gateway runtime surface is intentionally out of scope for this
  // test; we only need the cron service to construct without throwing
  // on a minimal config. Each runtime surface is a no-op stub.
  return {
    cfg: {
      agents: { defaults: { userTimezone: overrides?.userTimezone ?? "UTC" } },
      cron: {
        maintenance: {
          enabled: true,
          window: { start: "02:00", end: "04:00", timezone: "UTC" },
          maintenanceAgents: ["ops"],
        },
      },
    },
    deps: {
      // The CliDeps surface is large; the test only needs the cron
      // service construction to succeed. Any property accessed by
      // buildGatewayCronService at construction time is read off the
      // cfg, not the deps, so an empty object suffices.
    } as RuntimeParams["deps"],
    broadcast: () => {},
    env: { ...process.env, OPENCLAW_SKIP_CRON: "1" },
  };
}

beforeEach(() => {
  resetMaintenanceDeferrals();
});
afterEach(() => {
  resetMaintenanceDeferrals();
});

describe("buildGatewayCronService clears the maintenance deferred queue on rebuild", () => {
  it("a second buildGatewayCronService() clears any backlog from the first", () => {
    // First service build (in a previous tick of the gateway, simulated
    // here as a synchronous call).
    const firstCron = buildGatewayCronService(stubRuntime());
    // Sanity: the first build did not throw and the runtime is healthy.
    expect(firstCron.cron).toBeDefined();

    // Simulate a deferral that happened during the first service's
    // lifetime.
    beginMaintenancePhase(1_000);
    recordMaintenanceDeferral({ jobId: "stale-job", agentId: "main", nowMs: 1_000 });
    expect(getMaintenanceDeferralCount()).toBe(1);

    // Hot-reload: the gateway rebuilds the cron service. The deferred
    // queue MUST be empty after the rebuild so the new service starts
    // from a clean slate.
    const second = buildGatewayCronService(stubRuntime({ userTimezone: "America/Los_Angeles" }));
    expect(second.cron).toBeDefined();
    expect(getMaintenanceDeferralCount()).toBe(0);
  });

  it("a rebuild without any prior backlog is a no-op", () => {
    const firstCron = buildGatewayCronService(stubRuntime());
    expect(firstCron.cron).toBeDefined();
    expect(getMaintenanceDeferralCount()).toBe(0);
    const second = buildGatewayCronService(stubRuntime({ userTimezone: "UTC" }));
    expect(second.cron).toBeDefined();
    expect(getMaintenanceDeferralCount()).toBe(0);
  });
});
