import { setImmediate as yieldImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { tryAcquireExclusiveSqliteCoordinator } from "../infra/sqlite-coordinator.js";
import {
  resolveStateDatabaseCoordinatorPath,
  resolveStateLifecycleRuntimeDirectory,
} from "../infra/state-database-coordinator.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { withOpenClawStateLease } from "./openclaw-state-lease.js";

describe.each([undefined, "existing"] as const)(
  "lease coordinator contention (%s schema)",
  (schemaPolicy) => {
    it.each(["release", "timeout", "abort", "cleanup"] as const)(
      "preserves the %s contract while an independent writer owns the lifecycle gate",
      async (ending) => {
        await withOpenClawTestState({ label: "lease-coordinator-contention" }, async (state) => {
          const database = openOpenClawStateDatabase({ env: state.env });
          const coordinatorPath = resolveStateDatabaseCoordinatorPath({
            databasePath: database.path,
            runtimeDirectory: resolveStateLifecycleRuntimeDirectory(),
            uid: typeof process.getuid === "function" ? process.getuid() : undefined,
          });
          const takeWriter = () => {
            const held = tryAcquireExclusiveSqliteCoordinator(coordinatorPath);
            if (!held) {
              throw new Error("independent writer did not acquire its coordinator");
            }
            return held;
          };
          let writer = ending === "cleanup" ? undefined : takeWriter();
          const controller = new AbortController();
          let entered = false;
          let cleanupRelease: Promise<void> | undefined;
          try {
            const operation = withOpenClawStateLease(
              {
                scope: "core:test",
                key: "contending-writer",
                database: { scope: "shared", schemaPolicy, options: { env: state.env } },
                leaseMs: 30_000,
                waitMs: ending === "timeout" ? 0 : 5_000,
                signal: controller.signal,
              },
              async (lease) => {
                entered = true;
                lease.assertOwned();
                if (ending === "cleanup") {
                  writer = takeWriter();
                  cleanupRelease = yieldImmediate().then(() => writer?.release());
                }
              },
            );
            if (ending === "timeout" || ending === "abort") {
              const rejected = expect(operation).rejects.toMatchObject({
                code:
                  ending === "timeout"
                    ? "OPENCLAW_STATE_LEASE_TIMEOUT"
                    : "OPENCLAW_STATE_LEASE_ABORTED",
              });
              if (ending === "abort") {
                controller.abort(new Error("cancel waiting acquisition"));
              }
              await rejected;
              expect(entered).toBe(false);
            } else {
              if (ending === "release") {
                expect(entered).toBe(false);
                writer?.release();
              }
              await operation;
              await cleanupRelease;
              expect(entered).toBe(true);
            }
            expect(
              database.db
                .prepare("SELECT owner FROM state_leases WHERE scope = ? AND lease_key = ?")
                .all("core:test", "contending-writer"),
            ).toEqual([]);
          } finally {
            writer?.release();
            await cleanupRelease;
          }
        });
      },
    );
  },
);
