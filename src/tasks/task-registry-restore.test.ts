import { expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { createAsyncRegistryRestore } from "./task-registry-restore.js";

it.each(
  (["unknown outcome", "cleanup aggregate"] as const).flatMap((kind) =>
    (
      [
        "none",
        "received",
        "reconciliation failure",
        "retired without receipts",
        "retired with receipts",
      ] as const
    ).map((receipts) => ({
      kind,
      receipts,
    })),
  ),
)("does not replay a superseded $kind with $receipts receipts", async ({ kind, receipts }) => {
  const retirementError = new Error("Synthetic retired admission");
  const retires = receipts.startsWith("retired");
  let retired = false;
  const context: OpenClawStateWorkerContext = {
    environment: { OPENCLAW_STATE_DIR: "/synthetic/restore" },
    coordinatorRuntime: { directory: "/synthetic/restore/coordinator", keepAlive: false },
    admission: {
      databasePath: "/synthetic/restore/state.sqlite",
      identity: { key: "fixture", canonicalPath: "/synthetic/restore/state.sqlite" },
      assertCurrent() {
        if (retired) {
          throw retirementError;
        }
      },
    },
  };
  const operationError =
    kind === "unknown outcome"
      ? new SqliteWorkerError("Synthetic uncertain restore", "outcome-unknown")
      : new AggregateError([new Error("Synthetic cleanup failure")], "Restore cleanup failed");
  const reconciliationError = new Error("Synthetic receipt reconciliation failed");
  const started = createDeferred();
  const release = createDeferred();
  const priorReceipts = receipts === "none" || receipts === "retired without receipts" ? 0 : 2;
  let current: { status: "uninitialized" | "ready" } = { status: "uninitialized" };
  let revision = 0;
  let restores = 0;
  let failures = 0;
  const received: number[] = [];
  const reconciled: number[] = [];
  const replaceProjection = () => {
    current = { status: "uninitialized" };
    revision += 1;
  };
  type Snapshot = { sequence: number };
  const store = {
    async withSnapshotAsync<T>(
      _context: OpenClawStateWorkerContext,
      consume: (snapshot: Snapshot) => T,
    ): Promise<T> {
      const sequence = ++restores;
      if (sequence <= priorReceipts) {
        replaceProjection();
      } else if (sequence === priorReceipts + 1) {
        started.resolve();
        await release.promise;
        throw operationError;
      }
      return consume({ sequence });
    },
  };
  const ensure = createAsyncRegistryRestore<Snapshot, typeof store>({
    isCurrentDatabase: () => true,
    getState: () => current,
    getRevision: () => revision,
    getStore: () => store,
    received(snapshot) {
      received.push(snapshot.sequence);
    },
    async reconcile(snapshot) {
      reconciled.push(snapshot.sequence);
      context.admission.assertCurrent();
      if (receipts === "reconciliation failure" && snapshot.sequence === 1) {
        throw reconciliationError;
      }
    },
    install() {
      current = { status: "ready" };
      return async (reconcile) => await reconcile();
    },
    fail(error) {
      failures += 1;
      throw error;
    },
  });
  const first = ensure(context);
  await started.promise;
  replaceProjection();
  const reloaded = ensure(context);
  const settled = Promise.allSettled([first, reloaded]);
  retired = retires;
  release.resolve();
  const results = await settled;

  expect(restores).toBe(priorReceipts + 1);
  expect(failures).toBe(0);
  expect(received).toEqual(priorReceipts ? [1, 2] : []);
  expect(reconciled).toEqual(received);
  for (const result of results) {
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") {
      throw new Error("Superseded failed restoration unexpectedly succeeded");
    }
    expect(result.reason.message).toContain(operationError.message);
    if (retires) {
      expect(result.reason).toBeInstanceOf(AggregateError);
      expect(result.reason.cause).toBe(operationError);
      expect(result.reason.errors.slice(0, 2)).toEqual([operationError, retirementError]);
      if (priorReceipts) {
        expect(result.reason.errors[2].errors).toEqual([retirementError, retirementError]);
      } else {
        expect(result.reason.errors).toHaveLength(2);
      }
    } else if (receipts === "reconciliation failure") {
      expect(result.reason).toBeInstanceOf(AggregateError);
      expect(result.reason.cause).toBe(operationError);
      expect(result.reason.errors).toEqual([operationError, reconciliationError]);
    } else {
      expect(result.reason).toBe(operationError);
    }
  }
});

it.each(["retirement", "database replacement", "failed state"] as const)(
  "drains accepted stale receipts before leaving restoration for %s",
  async (exit) => {
    const primary = new Error("Synthetic restoration exit");
    const reconciliationError = new Error("Synthetic receipt failure");
    let retired = false;
    let currentDatabase = true;
    let current: { status: "uninitialized" } | { status: "failed"; error: Error } = {
      status: "uninitialized",
    };
    const context: OpenClawStateWorkerContext = {
      environment: { OPENCLAW_STATE_DIR: "/synthetic/receipt-exit" },
      coordinatorRuntime: { directory: "/synthetic/receipt-exit", keepAlive: false },
      admission: {
        databasePath: "/synthetic/receipt-exit/state.sqlite",
        identity: { key: "fixture", canonicalPath: "/synthetic/receipt-exit/state.sqlite" },
        assertCurrent() {
          if (retired) {
            throw primary;
          }
        },
      },
    };
    const started = createDeferred();
    const release = createDeferred();
    let restores = 0;
    const reconciled: number[] = [];
    const store = {
      async withSnapshotAsync<T>(
        _context: OpenClawStateWorkerContext,
        consume: (snapshot: number) => T,
      ): Promise<T> {
        restores += 1;
        current = { status: "uninitialized" };
        const result = await consume(restores);
        started.resolve();
        await release.promise;
        if (exit === "retirement") {
          retired = true;
        }
        if (exit === "database replacement") {
          currentDatabase = false;
        }
        if (exit === "failed state") {
          current = { status: "failed", error: primary };
        }
        return result;
      },
    };
    const ensure = createAsyncRegistryRestore<number, typeof store>({
      isCurrentDatabase: () => currentDatabase,
      getState: () => current,
      getRevision: () => 0,
      getStore: () => store,
      async reconcile(snapshot) {
        reconciled.push(snapshot);
        if (exit === "failed state") {
          throw reconciliationError;
        }
      },
      install() {
        throw new Error("Stale snapshot must not install");
      },
      fail() {
        throw new Error("Exit must not replace current owner state");
      },
    });
    const first = ensure(context);
    await started.promise;
    const second = ensure(context);
    const settled = Promise.allSettled([first, second]);
    release.resolve();
    const results = await settled;
    expect(restores).toBe(1);
    expect(reconciled).toEqual([1]);
    for (const result of results) {
      if (exit === "database replacement") {
        expect(result.status).toBe("fulfilled");
      } else {
        expect(result.status).toBe("rejected");
        if (result.status !== "rejected") {
          throw new Error("Restoration exit unexpectedly succeeded");
        }
        if (exit === "failed state") {
          expect(result.reason.cause).toBe(primary);
          expect(result.reason.errors).toEqual([primary, reconciliationError]);
        } else {
          expect(result.reason).toBe(primary);
        }
      }
    }
  },
);
