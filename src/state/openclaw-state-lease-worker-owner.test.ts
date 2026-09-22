import { MessageChannel } from "node:worker_threads";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SqliteWorkerOperationSettlement } from "../infra/sqlite-worker-operation-settlement.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { OpenClawStateLeaseContext } from "./openclaw-state-lease-context.js";
import { OpenClawStateLeaseError } from "./openclaw-state-lease-error.js";
import {
  createOpenClawStateLeaseWorkerOwner,
  withOpenClawStateLeaseWorkerAdmission,
} from "./openclaw-state-lease-worker-owner.js";

const forbiddenSqlite = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("Worker owner boundary tests must not open SQLite");
  }),
);
vi.mock("../infra/node-sqlite.js", () => ({ openNodeSqliteDatabase: forbiddenSqlite }));

afterEach(() => {
  expect(forbiddenSqlite).not.toHaveBeenCalled();
});

function fixture() {
  const databasePath = "/synthetic-state/lease.sqlite";
  const lease: OpenClawStateLeaseContext = {
    signal: new AbortController().signal,
    assertOwned() {},
    assertOwnedInTransaction() {},
  };
  const owner = createOpenClawStateLeaseWorkerOwner({
    lease,
    identity: { scope: "core:test", key: "result-boundary", owner: "synthetic-owner" },
    databasePath,
    assertCurrent: () => lease.assertOwned(),
  });
  return { lease, owner, databasePath };
}

async function nextMessageTurn(): Promise<void> {
  const { port1, port2 } = new MessageChannel();
  try {
    await new Promise<void>((resolve) => {
      port1.once("message", () => resolve());
      port2.postMessage(undefined);
    });
  } finally {
    port1.close();
    port2.close();
  }
}

describe("state lease worker result boundary", () => {
  it.each(["reject", "handled failure"] as const)(
    "reports unknown settlement before a caller observes %s",
    async (completion) => {
      const f = fixture();
      const settled = createDeferredCore<SqliteWorkerOperationSettlement>();
      const settlementError = new Error("Synthetic command settlement is unknown");
      const commandError = new Error("Synthetic command delivery failed");
      const observer = vi.fn<(kind: "success" | "failure", value: unknown) => void>();
      const nextOperation = vi.fn(async () => "continued");
      try {
        const operation = withOpenClawStateLeaseWorkerAdmission(
          f.lease,
          f.databasePath,
          async (scope) => {
            const { admission } = scope.createAdmission({ settled: settled.promise });
            try {
              // The broker publishes native settlement before delivering the command result.
              settled.resolve({ kind: "unknown", error: settlementError });
              if (completion === "handled failure") {
                await Promise.reject(commandError).catch(() => undefined);
                return "handled";
              }
              throw commandError;
            } finally {
              admission.finish();
            }
          },
        );
        const observed = await operation.then(
          (value) => {
            observer("success", value);
            return { ok: true as const, value };
          },
          (error: unknown) => {
            observer("failure", error);
            return { ok: false as const, error };
          },
        );

        expect(observed).toMatchObject({ ok: false, error: { code: "outcome-unknown" } });
        expect(observer).toHaveBeenCalledExactlyOnceWith(
          "failure",
          expect.objectContaining({ code: "outcome-unknown" }),
        );
        const error = observed.ok ? undefined : observed.error;
        const causes = collectNestedErrorCandidates(error);
        expect(causes).toContain(settlementError);
        if (completion === "reject") {
          expect(causes).toContain(commandError);
        }
        expect(f.owner.canRelease()).toBe(false);
        await expect(
          Promise.resolve().then(() =>
            withOpenClawStateLeaseWorkerAdmission(f.lease, f.databasePath, nextOperation),
          ),
        ).rejects.toMatchObject({ code: "outcome-unknown" });
        expect(nextOperation).not.toHaveBeenCalled();

        const authorityError = new OpenClawStateLeaseError("Synthetic lease authority was lost", {
          code: "OPENCLAW_STATE_LEASE_LOST",
        });
        let combined: unknown;
        try {
          f.owner.rethrowIfUncertain(error, authorityError);
        } catch (failure) {
          combined = failure;
        }
        expect(combined).toMatchObject({
          code: "outcome-unknown",
          cause: expect.any(AggregateError),
        });
        const combinedCauses = collectNestedErrorCandidates(combined);
        expect(combinedCauses).toContain(error);
        expect(combinedCauses).toContain(settlementError);
        expect(combinedCauses).toContain(authorityError);
        if (completion === "reject") {
          expect(combinedCauses).toContain(commandError);
        }
      } finally {
        settled.resolve({ kind: "completed" });
        try {
          await expect(f.owner.drain()).rejects.toMatchObject({ code: "outcome-unknown" });
        } finally {
          f.owner.close();
        }
      }
    },
  );

  it.each(["completed", "not-entered"] as const)(
    "preserves the exact original failure for %s settlement",
    async (kind) => {
      const f = fixture();
      const settled = createDeferredCore<SqliteWorkerOperationSettlement>();
      const commandError = new Error("Synthetic known command failure");
      const nextOperation = vi.fn(async () => "continued");
      try {
        const operation = withOpenClawStateLeaseWorkerAdmission(
          f.lease,
          f.databasePath,
          async (scope) => {
            const { admission } = scope.createAdmission({ settled: settled.promise });
            try {
              settled.resolve(kind === "completed" ? { kind } : { kind, error: commandError });
              throw commandError;
            } finally {
              admission.finish();
            }
          },
        );
        await expect(operation).rejects.toBe(commandError);
        expect(f.owner.canRelease()).toBe(true);
        await expect(
          withOpenClawStateLeaseWorkerAdmission(f.lease, f.databasePath, nextOperation),
        ).resolves.toBe("continued");
        expect(nextOperation).toHaveBeenCalledOnce();
      } finally {
        settled.resolve({ kind: "completed" });
        try {
          await f.owner.drain();
        } finally {
          f.owner.close();
        }
      }
    },
  );

  it("joins retained settlement after the callback completes and closes further admission", async () => {
    const f = fixture();
    const settled = createDeferredCore<SqliteWorkerOperationSettlement>();
    const nextOperation = vi.fn(async () => "continued");
    try {
      await expect(
        withOpenClawStateLeaseWorkerAdmission(f.lease, f.databasePath, async (scope) => {
          const { admission } = scope.createAdmission({ settled: settled.promise });
          try {
            return "completed callback";
          } finally {
            admission.finish();
          }
        }),
      ).resolves.toBe("completed callback");
      expect(f.owner.canRelease()).toBe(false);
      let drained = false;
      const drain = f.owner.drain().then(() => {
        drained = true;
      });
      // An event-loop turn flushes promise continuations without timing a native operation.
      await nextMessageTurn();
      expect(drained).toBe(false);
      await expect(
        Promise.resolve().then(() =>
          withOpenClawStateLeaseWorkerAdmission(f.lease, f.databasePath, nextOperation),
        ),
      ).rejects.toThrow();
      expect(nextOperation).not.toHaveBeenCalled();
      settled.resolve({ kind: "completed" });
      await drain;
      expect(drained).toBe(true);
      expect(f.owner.canRelease()).toBe(true);
    } finally {
      settled.resolve({ kind: "completed" });
      try {
        await f.owner.drain();
      } finally {
        f.owner.close();
      }
    }
  });
});
