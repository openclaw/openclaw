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
  renewalFailure: undefined as Error | undefined,
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
vi.mock("./openclaw-state-lease-storage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openclaw-state-lease-storage.js")>()),
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
    if (fixture.renewalFailure) {
      throw fixture.renewalFailure;
    }
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
  fixture.renewalFailure = undefined;
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

it.each(
  (["live", "expired", "renewed"] as const).flatMap((state) =>
    (["current", "admission"] as const).map((boundary) => ({ state, boundary })),
  ),
)(
  "gates effects on a $state native lease at the $boundary boundary",
  async ({ state, boundary }) => {
    const effect = vi.fn();
    const operation = withLease({ ...options, processBound: true }, async (lease) => {
      const run = (assertCurrent: () => void) => {
        if (state === "renewed") {
          vi.setSystemTime(9_500);
          lease.renew?.();
        }
        // Change only the clock; the queued expiry callback has not run.
        vi.setSystemTime(state === "live" ? 9_999 : 10_000);
        assertCurrent();
        effect();
      };
      if (boundary === "current") {
        run(lease.assertCurrent);
      } else {
        await withAdmission(lease, "/synthetic-state/lease.sqlite", async (admission) =>
          run(() => admission.assertCurrent()),
        );
      }
    });
    if (state === "expired") {
      await expect(operation).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
    } else {
      await operation;
    }
    expect(effect).toHaveBeenCalledTimes(state === "expired" ? 0 : 1);
  },
);

it("keeps the confirmed expiry when renewal has an unknown outcome", async () => {
  const failure = new Error("Synthetic renewal connection lost");
  const effect = vi.fn();
  await expect(
    withLease({ ...options, processBound: true }, async (lease) => {
      vi.setSystemTime(9_500);
      fixture.renewalFailure = failure;
      expect(() => lease.renew?.()).toThrow(failure);
      lease.assertCurrent();
      // The durable write may have succeeded, but its reply did not confirm the new expiry.
      vi.setSystemTime(10_000);
      lease.assertCurrent();
      effect();
    }),
  ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
  expect(effect).not.toHaveBeenCalled();
});
