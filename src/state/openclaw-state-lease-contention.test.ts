import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import * as backoff from "../infra/backoff.js";
import { defaultPayload } from "../infra/gateway-state-owner-record.js";
import { resolveGatewayStateOwnerPath } from "../infra/gateway-state-owner.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { withOpenClawStateLease } from "./openclaw-state-lease.js";

it.each([
  { schemaPolicy: undefined, ending: "release" },
  { schemaPolicy: undefined, ending: "timeout" },
  { schemaPolicy: undefined, ending: "deadline" },
  { schemaPolicy: undefined, ending: "abort" },
  { schemaPolicy: undefined, ending: "cleanup" },
  { schemaPolicy: "existing", ending: "release" },
  { schemaPolicy: "existing", ending: "cleanup" },
] as const)("handles $ending contention ($schemaPolicy)", ({ schemaPolicy, ending }) =>
  withOpenClawTestState({ label: "lease-native-contention" }, async (state) => {
    const database = openOpenClawStateDatabase({ env: state.env });
    const takeWriter = () => {
      const held = new DatabaseSync(database.path);
      held.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
      return () => {
        if (held.isOpen) {
          held.exec("ROLLBACK");
          held.close();
        }
      };
    };
    const cleanup = ending === "cleanup";
    let writer = cleanup ? undefined : takeWriter();
    const controller = new AbortController();
    let entered = 0;
    let cleanupRelease: Promise<void> | undefined;
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const retry = vi.spyOn(backoff, "sleepWithAbort").mockImplementation(async () => {
      if (ending === "release") {
        writer?.();
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
            cleanupRelease = yieldImmediate().then(() => writer?.());
          }
        },
      );
      const failed = ending === "timeout" || ending === "deadline" || ending === "abort";
      if (ending === "release") {
        expect(entered).toBe(0);
      }
      if (failed) {
        const aborted = ending === "abort";
        await expect(operation).rejects.toMatchObject({
          code: aborted ? "OPENCLAW_STATE_LEASE_ABORTED" : "OPENCLAW_STATE_LEASE_STORAGE_FAILED",
          outcome: aborted
            ? { kind: "aborted", reason: "caller-signal", elapsedMs: expect.any(Number) }
            : { kind: "store-unavailable", reason: "sqlite-busy" },
        });
      } else {
        await operation;
      }
      await cleanupRelease;
      expect(entered).toBe(failed ? 0 : 1);
      expect(
        database.db
          .prepare("SELECT owner FROM state_leases WHERE scope = ? AND lease_key = ?")
          .all("core:test", "contending-writer"),
      ).toEqual([]);
    } finally {
      retry.mockRestore();
      clock.mockRestore();
      vi.useRealTimers();
      writer?.();
      await cleanupRelease;
    }
  }),
);

it("releases a lease after its cleanup met another process's offline maintenance", async () => {
  await withOpenClawTestState({ label: "lease-maintenance-release" }, async (state) => {
    const database = openOpenClawStateDatabase({ env: state.env });
    const ownerPath = resolveGatewayStateOwnerPath(database.path);
    // A live foreign process records offline maintenance custody, as a CLI one-shot can.
    const holder = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const endMaintenance = () => fs.rmSync(ownerPath, { force: true });
    const leaseOwners = () =>
      database.db
        .prepare("SELECT owner FROM state_leases WHERE scope = ? AND lease_key = ?")
        .all("core:test", "maintenance-release");
    const options = {
      scope: "core:test",
      key: "maintenance-release",
      database: { scope: "shared" as const, options: { env: state.env } },
      leaseMs: 30_000,
    };
    try {
      await expect(
        withOpenClawStateLease({ ...options, waitMs: 0 }, async () => {
          fs.mkdirSync(path.dirname(ownerPath), { recursive: true });
          fs.writeFileSync(
            ownerPath,
            JSON.stringify({
              ...defaultPayload(database.path),
              pid: holder.pid,
              startTime: undefined,
            }),
          );
        }),
      ).rejects.toThrow("State lease operation and cleanup failed");
      expect(leaseOwners()).toHaveLength(1);
      endMaintenance();
      // Without a retried release, the stored lease holds every acquirer until it expires.
      await expect(
        withOpenClawStateLease({ ...options, waitMs: 10_000 }, async () => leaseOwners()),
      ).resolves.toHaveLength(1);
      expect(leaseOwners()).toEqual([]);
    } finally {
      endMaintenance();
      holder.kill();
    }
  });
});
