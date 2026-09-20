import { afterEach, describe, expect, it, vi } from "vitest";
import * as backoff from "../infra/backoff.js";
import { tryAcquireExclusiveSqliteCoordinator } from "../infra/sqlite-coordinator.js";
import {
  resolveStateDatabaseCoordinatorPath,
  resolveStateLifecycleRuntimeDirectory,
} from "../infra/state-database-coordinator.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import * as leaseStore from "./openclaw-state-lease-store.js";
import { withOpenClawStateLease } from "./openclaw-state-lease.js";

afterEach(() => vi.restoreAllMocks());

describe.each([undefined, true, false] as const)("lease admission (waitForLease=%s)", (mode) => {
  it.each(["holder", "storage", "late grant"] as const)(
    "preserves the distinct outcome for %s contention",
    async (contention) => {
      await withOpenClawTestState({ label: "lease-admission-contract" }, async (state) => {
        const database = openOpenClawStateDatabase({ env: state.env });
        const options = {
          scope: "core:test",
          key: "admission-contract",
          database: { scope: "shared" as const, options: { env: state.env } },
          leaseMs: 30_000,
          waitMs: 100,
          ...(mode === undefined ? {} : { waitForLease: mode }),
        };
        let elapsed = 0;
        vi.spyOn(performance, "now").mockImplementation(() => elapsed);
        let writer: ReturnType<typeof tryAcquireExclusiveSqliteCoordinator> | undefined;
        const sleep = vi.spyOn(backoff, "sleepWithAbort").mockImplementation(async (delayMs) => {
          elapsed += delayMs;
          expect(elapsed).toBeLessThanOrEqual(100);
          if (contention === "late grant") {
            writer?.release();
          }
        });
        const run = vi.fn(async () => undefined);
        const refuse = async () => {
          const failure: unknown = await withOpenClawStateLease(options, run).catch(
            (error: unknown) => error,
          );
          expect(run).not.toHaveBeenCalled();
          if (mode !== false) {
            expect(failure).toMatchObject({
              code: "OPENCLAW_STATE_LEASE_TIMEOUT",
              message: "timed out waiting for state lease core:test/admission-contract",
              cause: undefined,
            });
          } else {
            expect(failure).toMatchObject({
              code: "STATE_LEASE_BUSY",
              message: expect.stringContaining("core:test/admission-contract"),
            });
            expect(failure).toMatchObject({ message: expect.stringContaining("100 ms") });
            if (contention === "storage") {
              expect(failure).toMatchObject({
                message: expect.stringContaining("shared-state database is busy"),
                cause: { family: "state-lifecycle" },
              });
            } else if (contention === "holder") {
              expect(failure).toMatchObject({
                message: expect.stringContaining("another operation holds the lease"),
              });
            }
          }
          if (mode === false && contention === "holder") {
            expect(sleep).not.toHaveBeenCalled();
            expect(elapsed).toBe(0);
          } else {
            expect(sleep).toHaveBeenCalled();
          }
        };
        try {
          if (contention === "holder") {
            await withOpenClawStateLease({ ...options, waitMs: 0 }, async (held) => {
              await refuse();
              held.assertOwned();
              expect(database.db.prepare("SELECT * FROM state_leases").all()).toHaveLength(1);
            });
          } else {
            const coordinatorPath = resolveStateDatabaseCoordinatorPath({
              databasePath: database.path,
              runtimeDirectory: resolveStateLifecycleRuntimeDirectory(),
              uid: typeof process.getuid === "function" ? process.getuid() : undefined,
            });
            writer = tryAcquireExclusiveSqliteCoordinator(coordinatorPath, { busyTimeoutMs: 0 });
            if (!writer) {
              throw new Error("Independent writer did not acquire the lifecycle gate");
            }
            if (contention === "late grant") {
              const acquire = leaseStore.acquireOpenClawStateLeaseInTransaction;
              vi.spyOn(leaseStore, "acquireOpenClawStateLeaseInTransaction").mockImplementation(
                (...args) => {
                  const result = acquire(...args);
                  elapsed += 1_000;
                  return result;
                },
              );
            }
            await refuse();
          }
        } finally {
          writer?.release();
        }
        expect(database.db.prepare("SELECT * FROM state_leases").all()).toEqual([]);
      });
    },
  );
});
