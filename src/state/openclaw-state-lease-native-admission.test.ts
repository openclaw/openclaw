import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withOpenClawStateLeaseWorkerAdmission } from "./openclaw-state-lease-worker-owner.js";
import { OpenClawStateLeaseError, withOpenClawStateLease } from "./openclaw-state-lease.js";

const fixture = vi.hoisted(() => ({
  expiresAt: 10_000,
  forbiddenSqlite: vi.fn(() => {
    throw new Error("Native admission boundary controls must not open SQLite");
  }),
}));

vi.mock("../infra/node-sqlite.js", () => ({
  openNodeSqliteDatabase: fixture.forbiddenSqlite,
}));
vi.mock("./openclaw-state-lease-storage.js", () => ({
  acquireLease: async () => ({ kind: "acquired", expiresAt: fixture.expiresAt }),
  prepareLeaseDatabase: fixture.forbiddenSqlite,
  resolveLeaseDatabasePath: () => "/synthetic-state/lease.sqlite",
  verifyOpenClawStateLeaseOwnership: () => {
    if (Date.now() >= fixture.expiresAt) {
      throw new OpenClawStateLeaseError("Synthetic lease ownership expired", {
        code: "OPENCLAW_STATE_LEASE_LOST",
      });
    }
    return fixture.expiresAt;
  },
  renewOpenClawStateLease: () => {
    fixture.expiresAt = Date.now() + 1_000;
    return fixture.expiresAt;
  },
  releaseOpenClawStateLeaseBestEffort: async () => {},
  releaseOpenClawStateLease: () => {},
}));
vi.mock("./openclaw-state-lease-exclusion.js", () => ({
  createOpenClawStateLeaseExclusion: () => ({
    canRelease: () => true,
    assertIfExcluded: () => false,
    runWithOwnerScope: (run: () => Promise<unknown>) => run(),
    drain: async () => {},
  }),
}));
vi.mock("./openclaw-state-lease-heartbeat.js", () => ({
  startOpenClawStateLeaseHeartbeat: () => {
    throw new Error("Native timer controls must not start a heartbeat worker");
  },
}));

beforeEach(() => {
  fixture.expiresAt = 10_000;
  vi.useFakeTimers();
  vi.setSystemTime(9_000);
});

afterEach(() => {
  expect(fixture.forbiddenSqlite).not.toHaveBeenCalled();
  vi.useRealTimers();
});

it.each(["live", "expired", "renewed"] as const)(
  "admits the next effect only while the original native lease is %s",
  async (state) => {
    const effect = vi.fn();
    const operation = withOpenClawStateLease(
      {
        scope: "projects.checkout",
        key: "synthetic-checkout",
        database: { scope: "shared" },
        leaseMs: 1_000,
        waitMs: 0,
      },
      async (lease) =>
        withOpenClawStateLeaseWorkerAdmission(
          lease,
          "/synthetic-state/lease.sqlite",
          async (admission) => {
            if (state === "renewed") {
              vi.setSystemTime(9_500);
              lease.renew?.();
            }
            // Change only the clock; the queued expiry callback has not run.
            vi.setSystemTime(state === "live" ? 9_999 : 10_000);
            admission.assertCurrent();
            effect();
          },
        ),
    );
    if (state === "expired") {
      await expect(operation).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
    } else {
      await operation;
    }
    expect(effect).toHaveBeenCalledTimes(state === "expired" ? 0 : 1);
  },
);
