import { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import * as backoff from "../infra/backoff.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { releaseOpenClawStateLeaseBestEffort } from "./openclaw-state-lease-storage.js";
import { withOpenClawStateLease } from "./openclaw-state-lease.js";

it.each([
  { schemaPolicy: undefined, ending: "release" },
  { schemaPolicy: undefined, ending: "timeout" },
  { schemaPolicy: undefined, ending: "deadline" },
  { schemaPolicy: undefined, ending: "abort" },
  { schemaPolicy: undefined, ending: "cleanup" },
  { schemaPolicy: undefined, ending: "delayed-cleanup" },
  { schemaPolicy: "existing", ending: "release" },
  { schemaPolicy: "existing", ending: "cleanup" },
] as const)(
  "preserves $ending under native write contention ($schemaPolicy schema)",
  async ({ schemaPolicy, ending }) => {
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
      const cleanup = ending === "cleanup" || ending === "delayed-cleanup";
      let writer = cleanup ? undefined : takeWriter();
      const controller = new AbortController();
      let entered = 0;
      let cleanupRelease: Promise<void> | undefined;
      const clock = vi.spyOn(performance, "now").mockReturnValue(0);
      const exec = database.db.exec.bind(database.db);
      const nativeExec = vi.spyOn(database.db, "exec").mockImplementation((sql) => {
        try {
          return exec(sql);
        } catch (error) {
          if (ending === "delayed-cleanup" && sql === "BEGIN IMMEDIATE") {
            // The writer still owns its lock when a delayed cleanup exhausts its retry budget.
            clock.mockReturnValue(2_001);
          }
          throw error;
        }
      });
      const retry = vi.spyOn(backoff, "sleepWithAbort").mockImplementation(async () => {
        if (ending === "release") {
          writer?.release();
        } else if (ending === "deadline") {
          clock.mockReturnValue(5_000);
        } else if (ending === "abort") {
          controller.abort(new Error("cancel waiting acquisition"));
        } else {
          throw new Error(`Unexpected acquisition retry for ${ending}`);
        }
      });
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
            entered += 1;
            lease.assertOwned();
            if (cleanup) {
              vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
              writer = takeWriter();
              cleanupRelease = yieldImmediate().then(() => writer?.release());
            }
          },
        );
        if (ending === "timeout" || ending === "deadline" || ending === "abort") {
          const rejected = expect(operation).rejects.toMatchObject({
            code:
              ending === "abort"
                ? "OPENCLAW_STATE_LEASE_ABORTED"
                : "OPENCLAW_STATE_LEASE_STORAGE_FAILED",
            outcome:
              ending === "abort"
                ? { kind: "aborted", reason: "caller-signal", elapsedMs: expect.any(Number) }
                : { kind: "store-unavailable", reason: "sqlite-busy" },
          });
          await rejected;
          expect(entered).toBe(0);
        } else {
          if (ending === "release") {
            expect(entered).toBe(0);
          }
          await operation;
          await cleanupRelease;
          expect(entered).toBe(1);
        }
        expect(retry).toHaveBeenCalledTimes(ending === "timeout" || cleanup ? 0 : 1);
        expect(
          database.db
            .prepare("SELECT owner FROM state_leases WHERE scope = ? AND lease_key = ?")
            .all("core:test", "contending-writer"),
        ).toEqual([]);
      } finally {
        retry.mockRestore();
        nativeExec.mockRestore();
        clock.mockRestore();
        vi.useRealTimers();
        writer?.release();
        await cleanupRelease;
      }
    });
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
