import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { resolveRuntimeWorkerThreadExecArgv } from "../infra/runtime-worker-url.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import {
  leaseHeartbeatState,
  type LeaseHeartbeatWorkerData,
} from "./openclaw-state-lease-heartbeat-shared.js";
import { acquireOpenClawStateLeaseInTransaction } from "./openclaw-state-lease-store.js";
import { runWithOpenClawStateLeaseWorker } from "./openclaw-state-lease-worker-operation.js";
import { withOpenClawStateLease } from "./openclaw-state-lease.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

it("keeps deferred activation pending until renewal commits after contention", async () => {
  await withOpenClawTestState({ label: "lease-activation-contention" }, async (state) => {
    const database = openOpenClawStateDatabase({ env: state.env });
    const identity = { scope: "core:test", key: "activation", owner: "fixture-owner" };
    const acquired = runOpenClawStateWriteTransaction(
      ({ db }) => acquireOpenClawStateLeaseInTransaction(db, identity, 30_000),
      { database, env: state.env },
    );
    if (acquired.kind !== "acquired") {
      throw new Error("Fixture did not acquire its lease");
    }
    const shared = new BigInt64Array(
      new SharedArrayBuffer(
        (leaseHeartbeatState.startupPhase + 1) * BigInt64Array.BYTES_PER_ELEMENT,
      ),
    );
    Atomics.store(shared, leaseHeartbeatState.expiresAt, BigInt(acquired.expiresAt));
    const moduleUrl = pathToFileURL(
      path.resolve("src/state/openclaw-state-lease-heartbeat.worker.ts"),
    ).href;
    // Observe completion of the real activation handler without adding a production test hook.
    const driver = await state.writeText(
      "activation-worker.mts",
      `
      import { parentPort } from "node:worker_threads";
      if (!parentPort) throw new Error("Missing fixture parent port");
      const on = parentPort.on.bind(parentPort);
      parentPort.on = (event, listener) => event === "message"
        ? on(event, (message) => {
            Reflect.apply(listener, parentPort, [message]);
            if (message?.startup === "activate") {
              queueMicrotask(() => parentPort.postMessage({ fixture: "activation-processed" }));
            }
          })
        : on(event, listener);
      await import(${JSON.stringify(moduleUrl)});
    `,
    );
    const driverUrl = pathToFileURL(driver);
    const worker = new Worker(driverUrl, {
      workerData: {
        path: database.path,
        expectedIdentity: readDatabasePathIdentitySync(database.path).key,
        identity,
        leaseMs: 30_000,
        acquiredAt: acquired.expiresAt - 30_000,
        heartbeatMs: 250,
        deferActivation: true,
        shared: shared.buffer,
        renewalProgress: new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT),
      } satisfies LeaseHeartbeatWorkerData,
      execArgv: resolveRuntimeWorkerThreadExecArgv(driverUrl),
      env: {},
    });
    const prepared = createDeferredCore();
    const processed = createDeferredCore();
    const ready = createDeferredCore();
    const exited = createDeferredCore();
    let stopping = false;
    for (const pending of [prepared, processed, ready]) {
      void pending.promise.catch(() => {});
    }
    const fail = (error: unknown) => {
      prepared.reject(error);
      processed.reject(error);
      ready.reject(error);
    };
    worker.on("error", fail);
    worker.once("exit", () => {
      exited.resolve();
      if (!stopping) {
        fail(new Error("Heartbeat fixture exited before activation completed"));
      }
    });
    worker.on("message", (message: unknown) => {
      if (message === null) {
        ready.resolve();
      } else if (typeof message === "object" && message !== null) {
        if ("startup" in message && message.startup === "prepared") {
          prepared.resolve();
        }
        if ("fixture" in message && message.fixture === "activation-processed") {
          processed.resolve();
        }
      }
    });
    const writer = new DatabaseSync(database.path);
    try {
      await prepared.promise;
      writer.exec("BEGIN IMMEDIATE");
      worker.postMessage({ startup: "activate" }, []);
      await processed.promise;
      expect(Atomics.load(shared, leaseHeartbeatState.status)).toBe(leaseHeartbeatState.starting);
      writer.exec("ROLLBACK");
      await ready.promise;
      expect(Atomics.load(shared, leaseHeartbeatState.status)).toBe(leaseHeartbeatState.ready);
      const row = database.db
        .prepare("SELECT expires_at FROM state_leases WHERE scope = ? AND lease_key = ?")
        .get(identity.scope, identity.key);
      expect(row?.expires_at).toBe(Number(Atomics.load(shared, leaseHeartbeatState.expiresAt)));
      expect(Number(row?.expires_at)).toBeGreaterThan(acquired.expiresAt);
    } finally {
      if (writer.isTransaction) {
        writer.exec("ROLLBACK");
      }
      writer.close();
      stopping = true;
      await worker.terminate();
      await exited.promise;
    }
  });
});

it("admits heartbeat-owned worker writes without blocking the host and rolls back revoked commits", async () => {
  await withOpenClawTestState({ label: "native-lease-worker-write" }, async (state) => {
    const database = openOpenClawStateDatabase({ env: state.env });
    const context = captureOpenClawStateWorkerContext({ env: state.env });
    const storeKey = "native-heartbeat-grants";
    await withOpenClawStateLease(
      {
        scope: "core:mcp-oauth",
        key: storeKey,
        database: { scope: "shared", options: { env: state.env } },
        leaseMs: 60_000,
        waitMs: 0,
        heartbeat: "worker",
      },
      async (lease) => {
        const { StatementSync } = requireNodeSqlite();
        const hostCalls = [
          vi.spyOn(DatabaseSync.prototype, "prepare"),
          vi.spyOn(DatabaseSync.prototype, "exec"),
          vi.spyOn(StatementSync.prototype, "get"),
          vi.spyOn(StatementSync.prototype, "all"),
          vi.spyOn(StatementSync.prototype, "run"),
          vi.spyOn(StatementSync.prototype, "iterate"),
          vi.spyOn(Atomics, "wait"),
        ];
        const caller = new AbortController();
        const revoked = new Error("Synthetic caller authority was revoked");
        const write = (marker: string, revokeAtCommit = false) =>
          runWithOpenClawStateLeaseWorker(
            lease,
            context,
            (scope, identity) =>
              scope.execute({
                type: "mcpOAuth.writePending",
                input: { storeKey, identity, state: marker },
              }),
            {
              assertCurrent: () => caller.signal.throwIfAborted(),
              beforeCommit: () => {
                if (revokeAtCommit) {
                  caller.abort(revoked);
                }
              },
            },
          );
        try {
          await write("accepted");
          await expect(write("refused", true)).rejects.toBe(revoked);
          for (const call of hostCalls) {
            expect(call).not.toHaveBeenCalled();
          }
        } finally {
          for (const call of hostCalls) {
            call.mockRestore();
          }
        }
      },
    );
    expect(
      database.db
        .prepare("SELECT state FROM mcp_oauth_pending_authorizations WHERE store_key = ?")
        .all(storeKey),
    ).toEqual([{ state: "accepted" }]);
    expect(
      database.db
        .prepare("SELECT owner FROM state_leases WHERE scope = ? AND lease_key = ?")
        .all("core:mcp-oauth", storeKey),
    ).toEqual([]);
  });
});
