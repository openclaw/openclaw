import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withOpenClawStateLeaseWorkerAdmission as withAdmission } from "./openclaw-state-lease-worker-owner.js";
import {
  OpenClawStateLeaseError,
  withOpenClawStateLease as withLease,
} from "./openclaw-state-lease.js";

const options = {
  scope: "projects.checkout",
  key: "synthetic-checkout",
  database: { scope: "shared" as const },
  leaseMs: 1_000,
  waitMs: 0,
};
const fixture = vi.hoisted(() => ({
  expiresAt: 10_000,
  forbiddenSqlite: vi.fn(() => {
    throw new Error("Native admission boundary controls must not open SQLite");
  }),
}));

vi.mock("../infra/node-sqlite.js", () => ({
  openNodeSqliteDatabase: fixture.forbiddenSqlite,
}));
vi.mock("./openclaw-state-lease-worker-storage.js", () => ({
  acquireLease: async () => ({ kind: "acquired", expiresAt: fixture.expiresAt }),
  createOpenClawStateLeaseWorkerStorage: fixture.forbiddenSqlite,
}));
vi.mock("./openclaw-state-lease-storage.js", () => ({
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

it("keeps a lease with a worker expiry 30 days ahead alive", async () => {
  fixture.expiresAt = Date.now() + 30 * 24 * 60 * 60_000;
  await withLease(options, async (lease) => {
    await vi.advanceTimersByTimeAsync(100);
    expect(lease.signal.aborted).toBe(false);
    lease.assertOwned();
  });
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["live", "expired", "renewed"] as const)(
  "gates effects on a %s native lease",
  async (state) => {
    const effect = vi.fn();
    const operation = withLease(options, async (lease) =>
      withAdmission(lease, "/synthetic-state/lease.sqlite", async (admission) => {
        if (state === "renewed") {
          vi.setSystemTime(9_500);
          lease.renew?.();
        }
        // Change only the clock; the queued expiry callback has not run.
        vi.setSystemTime(state === "live" ? 9_999 : 10_000);
        admission.assertCurrent();
        effect();
      }),
    );
    if (state === "expired") {
      await expect(operation).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
    } else {
      await operation;
    }
    expect(effect).toHaveBeenCalledTimes(state === "expired" ? 0 : 1);
  },
);
