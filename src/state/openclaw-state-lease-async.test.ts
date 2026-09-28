import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";
import {
  withOpenClawStateLeaseAsync,
  type OpenClawStateAsyncLeaseContext,
} from "./openclaw-state-lease.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

describe("worker state lease lifecycle", () => {
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
      const lease = await Promise.race([
        entered.promise,
        outcome.then((error) => {
          throw toErrorObject(error, "Lease completed before callback entry");
        }),
      ]);
      let closed = false;
      const closing = closeOpenClawStateDatabaseAsync().then(() => {
        closed = true;
      });
      try {
        if (!lease.signal.aborted) {
          await new Promise<void>((resolve) => {
            lease.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        expect(closed).toBe(false);
        await expect(lease.renew()).rejects.toMatchObject({
          code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED",
        });
        finish.resolve();
        expect(await outcome).toBeInstanceOf(Error);
        await closing;
        const database = openOpenClawStateDatabase({ env: state.env });
        expect(
          database.db
            .prepare("SELECT owner FROM state_leases WHERE scope = ? AND lease_key = ?")
            .all("core:test", "close"),
        ).toEqual([]);
      } finally {
        finish.resolve();
        await outcome;
        await closing;
      }
    });
  });

  it.each([
    { heartbeat: undefined, leaseMs: 30_000 },
    { heartbeat: "worker", leaseMs: 30_000 },
    { heartbeat: "worker", leaseMs: 1_000 },
  ] as const)(
    "runs the complete $heartbeat heartbeat lifecycle with a $leaseMs ms lease without parent SQL or waits",
    async ({ heartbeat, leaseMs }) => {
      await withOpenClawTestState({ label: "async-lease-lifecycle" }, async (state) => {
        const { DatabaseSync, StatementSync } = requireNodeSqlite();
        openOpenClawStateDatabase({ env: state.env });
        await closeOpenClawStateDatabaseAsync();
        const parentCalls = {
          prepare: vi.spyOn(DatabaseSync.prototype, "prepare"),
          exec: vi.spyOn(DatabaseSync.prototype, "exec"),
          close: vi.spyOn(DatabaseSync.prototype, "close"),
          get: vi.spyOn(StatementSync.prototype, "get"),
          all: vi.spyOn(StatementSync.prototype, "all"),
          run: vi.spyOn(StatementSync.prototype, "run"),
          iterate: vi.spyOn(StatementSync.prototype, "iterate"),
          wait: vi.spyOn(Atomics, "wait"),
        };
        let retired: OpenClawStateAsyncLeaseContext | undefined;
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
          await withOpenClawStateLeaseAsync(options, context, async (lease) => {
            retired = lease;
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
          });
          expect(blocked).not.toHaveBeenCalled();
          await expect(retired?.assertOwned()).rejects.toThrow();
          await closeOpenClawStateDatabaseAsync();
          expect(
            Object.fromEntries(
              Object.entries(parentCalls).map(([name, spy]) => [name, spy.mock.calls.length]),
            ),
          ).toEqual({ prepare: 0, exec: 0, close: 0, get: 0, all: 0, run: 0, iterate: 0, wait: 0 });
        } finally {
          try {
            await closeOpenClawStateDatabaseAsync();
          } finally {
            for (const spy of Object.values(parentCalls)) {
              spy.mockRestore();
            }
          }
        }
        const database = openOpenClawStateDatabase({ env: state.env });
        expect(
          database.db
            .prepare("SELECT owner FROM state_leases WHERE scope = ? AND lease_key = ?")
            .all("core:test", "async-lifecycle"),
        ).toEqual([]);
      });
    },
  );
});
