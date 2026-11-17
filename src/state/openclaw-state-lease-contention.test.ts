import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { withLocalWorkspaceStore } from "../gateway/worker-environments/local-workspace-store.js";
import { localWorkspaceProjectionFixture } from "../gateway/worker-environments/local-workspace-store.test-support.js";
import * as backoff from "../infra/backoff.js";
import { defaultPayload } from "../infra/gateway-state-owner-record.js";
import { resolveGatewayStateOwnerPath } from "../infra/gateway-state-owner.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { withOpenClawStateLease, withOpenClawStateLeaseAsync } from "./openclaw-state-lease.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import * as stateWorker from "./openclaw-state-worker-store.js";

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

it("renews behind its own workspace writes without SQLite BUSY or reacquisition", async () => {
  await withOpenClawTestState({ label: "workspace-own-write-renewal" }, async ({ env, root }) => {
    await withLocalWorkspaceStore({ worktreeId: "own-worktree", env }, async (store) => {
      const lease = store.workerAuthority.leaseSet!.leases.at(-1)!;
      const outcomes: string[] = [];
      const commands = probe.command(stateWorker, async (command, options, scope) => {
        const write = scope.execute(command, options);
        if (command.type !== "localWorkspace.mutate") {
          return write;
        }
        // Queue renewal while the real mutation still owns its worker command.
        const renewal = Promise.resolve(lease.renew?.()).then(() => outcomes.push("renewed"));
        const result = await write;
        outcomes.push("committed");
        await renewal;
        return result;
      });
      try {
        let row = await store.create(localWorkspaceProjectionFixture("own-worktree", root));
        for (let cycle = 0; cycle < 3; cycle++) {
          row = await store.update(row, { created_at_ms: cycle + 2 });
        }
        expect(outcomes).toEqual(Array.from({ length: 4 }, () => ["committed", "renewed"]).flat());
        expect(lease.signal.aborted).toBe(false);
        await lease.assertOwned();
      } finally {
        commands.mockRestore();
      }
    });
  });
});

it("retries real SQLite BUSY renewal before the next heartbeat without surrendering exclusion", async () => {
  await withOpenClawTestState({ label: "async-lease-busy-renewal" }, async ({ env }) => {
    const database = openOpenClawStateDatabase({ env });
    const context = captureOpenClawStateWorkerContext({ env });
    const writer = new DatabaseSync(database.path);
    const busy = createDeferredCore<unknown>();
    const renewed = createDeferredCore();
    let renewals = 0;
    const commands = probe.command(stateWorker, async (command, options, scope) => {
      if (command.type !== "stateLease.renew") {
        return scope.execute(command, options);
      }
      renewals++;
      try {
        const result = await scope.execute(command, options);
        renewed.resolve();
        return result;
      } catch (error) {
        busy.resolve(error);
        throw error;
      }
    });
    const options = {
      scope: "workspace.local-reconciliation",
      key: "own-worktree",
      leaseMs: 30_000,
      waitMs: 0,
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      await withOpenClawStateLeaseAsync(options, context, async (lease, identity) => {
        writer.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
        await vi.advanceTimersByTimeAsync(10_000);
        expect(await busy.promise).toMatchObject({ errcode: 5 });
        writer.exec("ROLLBACK");
        await vi.advanceTimersByTimeAsync(25);
        await renewed.promise;
        expect(renewals).toBe(2);
        await lease.assertOwned();
        expect(lease.signal.aborted).toBe(false);
        await expect(
          withOpenClawStateLeaseAsync(options, context, async () => {}),
        ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_HELD" });
        expect(
          writer
            .prepare("SELECT owner FROM state_leases WHERE scope = ? AND lease_key = ?")
            .get(options.scope, options.key)?.owner,
        ).toBe(identity.owner);
      });
    } finally {
      if (writer.isTransaction) {
        writer.exec("ROLLBACK");
      }
      vi.useRealTimers();
      commands.mockRestore();
      writer.close();
    }
  });
});
