import { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { releaseOpenClawStateLeaseBestEffort } from "./openclaw-state-lease-storage.js";
import { withOpenClawStateLease } from "./openclaw-state-lease.js";

describe.each([undefined, "existing"] as const)(
  "lease SQLite contention (%s schema)",
  (schemaPolicy) => {
    it.each(["release", "timeout", "abort", "cleanup"] as const)(
      "preserves the %s contract while an independent writer holds a native write transaction",
      async (ending) => {
        await withOpenClawTestState({ label: "lease-native-contention" }, async (state) => {
          const database = openOpenClawStateDatabase({ env: state.env });
          const takeWriter = () => {
            const held = new DatabaseSync(database.path);
            held.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
            return {
              release() {
                if (held.isOpen) {
                  held.exec("ROLLBACK");
                  held.close();
                }
              },
            };
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
                  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
                  writer = takeWriter();
                  cleanupRelease = yieldImmediate().then(() => writer?.release());
                }
              },
            );
            if (ending === "timeout" || ending === "abort") {
              const rejected = expect(operation).rejects.toMatchObject({
                code:
                  ending === "timeout"
                    ? "OPENCLAW_STATE_LEASE_STORAGE_FAILED"
                    : "OPENCLAW_STATE_LEASE_ABORTED",
                outcome:
                  ending === "timeout"
                    ? { kind: "store-unavailable", reason: "sqlite-busy" }
                    : { kind: "aborted", reason: "caller-signal", elapsedMs: expect.any(Number) },
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
            vi.useRealTimers();
            writer?.release();
            await cleanupRelease;
          }
        });
      },
    );
  },
);

it("preserves a failed async release for its retained cleanup owner", async () => {
  const failure = new Error("Synthetic cleanup worker failed before release");
  await expect(
    releaseOpenClawStateLeaseBestEffort(
      {
        scope: "core:test",
        key: "retained-release",
        owner: "synthetic-owner",
        leaseLabel: "state lease",
        operationLabel: "test.release",
        database: { scope: "shared" },
      },
      async () => {
        throw failure;
      },
    ),
  ).rejects.toBe(failure);
});
