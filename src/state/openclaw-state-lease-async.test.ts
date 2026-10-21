import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { createDeferredCore } from "../shared/deferred.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { withOpenClawStateLeasesWorkerAdmission } from "./openclaw-state-lease-worker-owner.js";
import {
  withOpenClawStateLeaseAsync,
  type OpenClawStateAsyncLeaseContext,
} from "./openclaw-state-lease.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

function expectReleased(database: ReturnType<typeof openOpenClawStateDatabase>, key: string) {
  expect(
    database.db
      .prepare("SELECT owner FROM state_leases WHERE scope = ? AND lease_key = ?")
      .all("core:test", key),
  ).toEqual([]);
}

it("refuses a worker-leased effect after expiry before the host expiry callback runs", async () => {
  await withOpenClawTestState({ label: "async-lease-effect-expiry" }, async (state) => {
    const context = captureOpenClawStateWorkerContext({ env: state.env });
    const effect = vi.fn();
    const operation = withOpenClawStateLeaseAsync(
      {
        scope: "core:test",
        key: "effect-expiry",
        leaseMs: 60_000,
        waitMs: 0,
        heartbeat: "worker",
      },
      context,
      (lease) =>
        withOpenClawStateLeasesWorkerAdmission([lease], context, async (authority) => {
          authority.assertCurrent();
          // No timer or worker notification runs between the clock change and this effect.
          const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
          try {
            expect(lease.signal.aborted).toBe(false);
            authority.assertCurrent();
            effect();
          } finally {
            clock.mockRestore();
          }
        }),
    );
    await expect(operation).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
    expect(effect).not.toHaveBeenCalled();
  });
});

it("drains an accepted callback and releases its lease during canonical close", async () => {
  await withOpenClawTestState({ label: "async-lease-canonical-close" }, async (state) => {
    const entered = createDeferredCore<OpenClawStateAsyncLeaseContext>();
    const finish = createDeferredCore();
    const operation = withOpenClawStateLeaseAsync(
      { scope: "core:test", key: "close", leaseMs: 30_000, waitMs: 0 },
      captureOpenClawStateWorkerContext({ env: state.env }),
      async (lease) => {
        entered.resolve(lease);
        await finish.promise;
      },
    );
    const outcome = operation.catch((error: unknown) => error);
    const lease = await awaitGateBeforeSettlement(
      entered.promise,
      operation,
      "Lease completed before callback entry",
    );
    const closed = vi.fn();
    const closing = closeOpenClawStateDatabaseAsync().then(closed);
    try {
      if (!lease.signal.aborted) {
        await once(lease.signal, "abort");
      }
      expect(closed).not.toHaveBeenCalled();
      await expect(lease.renew()).rejects.toMatchObject({
        code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED",
      });
      finish.resolve();
      expect(await outcome).toBeInstanceOf(Error);
      await closing;
      expectReleased(openOpenClawStateDatabase({ env: state.env }), "close");
    } finally {
      finish.resolve();
      await outcome;
      await closing;
    }
  });
});

it.each([
  { heartbeat: undefined, leaseMs: 30_000 },
  { heartbeat: "worker", leaseMs: 1_000 },
] as const)(
  "runs the complete $heartbeat heartbeat lifecycle with a $leaseMs ms lease without parent SQL or waits",
  async ({ heartbeat, leaseMs }) => {
    await withOpenClawTestState({ label: "async-lease-lifecycle" }, async (state) => {
      openOpenClawStateDatabase({ env: state.env });
      await closeOpenClawStateDatabaseAsync();
      const sql = observeMainThreadSql({ includeClose: true });
      const wait = vi.spyOn(Atomics, "wait");
      try {
        const context = captureOpenClawStateWorkerContext({ env: state.env });
        const options = {
          scope: "core:test",
          key: "async-lifecycle",
          leaseMs,
          waitMs: 0,
          heartbeat,
        };
        const blocked = vi.fn(async () => {});
        const retired = await withOpenClawStateLeaseAsync(options, context, async (lease) => {
          await lease.assertOwned();
          await lease.renew();
          await expect(
            withOpenClawStateLeaseAsync(options, context, blocked),
          ).rejects.toMatchObject({
            code: "OPENCLAW_STATE_LEASE_HELD",
            outcome: {
              kind: "held",
              holder: { owner: expect.any(String), epoch: expect.any(Number) },
            },
          });
          await lease.assertOwned();
          return lease;
        });
        expect(blocked).not.toHaveBeenCalled();
        await expect(retired.assertOwned()).rejects.toThrow();
        await closeOpenClawStateDatabaseAsync();
        sql.expectIdle();
        expect(wait).not.toHaveBeenCalled();
      } finally {
        try {
          await closeOpenClawStateDatabaseAsync();
        } finally {
          sql.restore();
          wait.mockRestore();
        }
      }
      expectReleased(openOpenClawStateDatabase({ env: state.env }), "async-lifecycle");
    });
  },
);
