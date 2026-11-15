import { once } from "node:events";
import { renameSync, unlinkSync } from "node:fs";
import fs from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { readGatewayLockProcessNamespace } from "../infra/gateway-lock-payload.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { createDeferredCore } from "../shared/deferred.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState as withState } from "../test-utils/openclaw-test-state.js";
import {
  closeOpenClawStateDatabaseAsync as closeDatabase,
  openOpenClawStateDatabase as openDatabase,
} from "./openclaw-state-db.js";
import { withOpenClawStateLeasesWorkerAdmission as withAdmission } from "./openclaw-state-lease-worker-owner.js";
import {
  withOpenClawStateLeaseAsync as withLease,
  type OpenClawStateAsyncLeaseContext,
} from "./openclaw-state-lease.js";
import { captureOpenClawStateWorkerContext as captureContext } from "./openclaw-state-worker-context.js";

const leaseOptions = { scope: "core:test", waitMs: 0, leaseMs: 30_000 };
function expectReleased(database: ReturnType<typeof openDatabase>, key: string) {
  expect(
    database.db
      .prepare("SELECT owner FROM state_leases WHERE scope = ? AND lease_key = ?")
      .all("core:test", key),
  ).toEqual([]);
}

// Windows does not permit this fixture to replace an open native database.
it.skipIf(process.platform === "win32").each([undefined, "worker"] as const)(
  "refuses a replaced cold-acquired database with %s heartbeat and settles without retiring its original actor",
  async (heartbeat) => {
    await withState({ label: "async-lease-replaced-source" }, async (state) => {
      const context = captureContext({ env: state.env });
      const operation = withLease(
        { ...leaseOptions, key: "replaced-source", heartbeat },
        context,
        async (lease) => {
          const databasePath = context.admission.databasePath;
          const original = `${databasePath}.original`;
          const replacement = `${databasePath}.replacement`;
          await fs.copyFile(databasePath, replacement);
          await fs.rename(databasePath, original);
          await fs.rename(replacement, databasePath);
          try {
            await expect(lease.assertOwned()).rejects.toThrow();
          } finally {
            await fs.unlink(databasePath);
            await fs.rename(original, databasePath);
          }
          // A heartbeat worker records permanent loss; a refused actor request still settles.
          if (heartbeat !== "worker") {
            await lease.assertOwned();
          }
        },
      );
      if (heartbeat === "worker") {
        await expect(operation).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
      } else {
        await operation;
      }
      await withLease({ ...leaseOptions, key: "original-sibling" }, context, async (lease) => {
        await lease.assertOwned();
      });
      expectReleased(openDatabase({ env: state.env }), "replaced-source");
    });
  },
);

// Windows does not permit replacing the heartbeat's open lock file.
it.skipIf(process.platform === "win32")(
  "refuses a held worker lease effect after identical-byte Gateway owner replacement",
  async () => {
    await withState({ label: "async-lease-replaced-gateway-owner" }, async (state) => {
      const database = openDatabase({ env: state.env });
      const owner = acquireGatewayStateOwner({
        databasePath: database.path,
        payload: {
          pid: process.pid,
          createdAt: new Date().toISOString(),
          configPath: state.configPath,
          processNamespace: readGatewayLockProcessNamespace(),
          role: "gateway",
        },
      });
      const effect = vi.fn();
      try {
        const operation = withLease(
          { ...leaseOptions, key: "replaced-gateway-owner", heartbeat: "worker" },
          captureContext({ env: state.env }),
          async (lease) => {
            await lease.assertOwned();
            const original = `${owner.path}.original`;
            const replacement = `${owner.path}.replacement`;
            await fs.copyFile(owner.path, replacement);
            renameSync(owner.path, original);
            renameSync(replacement, owner.path);
            try {
              await lease.assertOwned();
              effect();
            } finally {
              unlinkSync(owner.path);
              renameSync(original, owner.path);
              // Restore custody before releasing it so accepted lease cleanup can settle.
              owner.release();
            }
          },
        );
        await expect(operation).rejects.toThrow();
        expect(effect).not.toHaveBeenCalled();
      } finally {
        owner.release();
      }
      expectReleased(openDatabase({ env: state.env }), "replaced-gateway-owner");
    });
  },
);

it("refuses a worker-leased effect after expiry before the host expiry callback runs", async () => {
  await withState({ label: "async-lease-effect-expiry" }, async (state) => {
    const context = captureContext({ env: state.env });
    const effect = vi.fn();
    const operation = withLease(
      {
        ...leaseOptions,
        key: "effect-expiry",
        leaseMs: 60_000,
        heartbeat: "worker",
      },
      context,
      (lease) =>
        withAdmission([lease], context, async (authority) => {
          authority.assertCurrent();
          lease.assertCurrent();
          // No timer or worker notification runs between the clock change and this effect.
          const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
          try {
            expect(lease.signal.aborted).toBe(false);
            expect(() => lease.assertCurrent()).toThrow();
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
  await withState({ label: "async-lease-canonical-close" }, async (state) => {
    const entered = createDeferredCore<OpenClawStateAsyncLeaseContext>();
    const finish = createDeferredCore();
    const operation = withLease(
      { ...leaseOptions, key: "close" },
      captureContext({ env: state.env }),
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
    const closing = closeDatabase().then(closed);
    try {
      if (!lease.signal.aborted) {
        await once(lease.signal, "abort");
      }
      expect(closed).not.toHaveBeenCalled();
      await expect(lease.renew()).rejects.toMatchObject({
        code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED",
      });
      expect(() => lease.assertCurrent()).toThrow();
      finish.resolve();
      expect(await outcome).toBeInstanceOf(Error);
      await closing;
      expectReleased(openDatabase({ env: state.env }), "close");
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
    await withState({ label: "async-lease-lifecycle" }, async (state) => {
      openDatabase({ env: state.env });
      await closeDatabase();
      const sql = observeMainThreadSql({ includeClose: true });
      const wait = vi.spyOn(Atomics, "wait");
      try {
        const context = captureContext({ env: state.env });
        const options = { ...leaseOptions, key: "async-lifecycle", leaseMs, heartbeat };
        const blocked = vi.fn(async () => {});
        const retired = await withLease(options, context, async (lease) => {
          await lease.assertOwned();
          await lease.renew();
          await expect(withLease(options, context, blocked)).rejects.toMatchObject({
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
        expect(() => retired.assertCurrent()).toThrow();
        await closeDatabase();
        sql.expectIdle();
        expect(wait).not.toHaveBeenCalled();
      } finally {
        try {
          await closeDatabase();
        } finally {
          sql.restore();
          wait.mockRestore();
        }
      }
      expectReleased(openDatabase({ env: state.env }), "async-lifecycle");
    });
  },
);
