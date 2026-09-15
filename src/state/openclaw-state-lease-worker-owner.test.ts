import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SqliteWorkerOperationSettlement } from "../infra/sqlite-worker-operation-settlement.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { OpenClawStateLeaseContext } from "./openclaw-state-lease-context.js";
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

describe("state lease worker result boundary", () => {
  it.each(["reject", "handled failure"] as const)(
    "reports unknown settlement before an outer cleanup observer sees %s",
    async (completion) => {
      const f = fixture();
      const settled = createDeferredCore<SqliteWorkerOperationSettlement>();
      const settlementError = new Error("Synthetic command settlement is unknown");
      const commandError = new Error("Synthetic command delivery failed");
      const cleanupObserver = vi.fn<(kind: "success" | "failure", value: unknown) => void>();
      const nextOperation = vi.fn(async () => "continued");
      try {
        const operation = withOpenClawStateLeaseWorkerAdmission(
          f.lease,
          f.databasePath,
          async (scope) => {
            const { admission } = scope.createAdmission({ settled: settled.promise });
            try {
              // Broker settlement precedes rejection of the associated command.
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
            cleanupObserver("success", value);
            return { ok: true as const, value };
          },
          (error: unknown) => {
            cleanupObserver("failure", error);
            return { ok: false as const, error };
          },
        );

        expect(observed).toMatchObject({
          ok: false,
          error: { code: "outcome-unknown" },
        });
        expect(cleanupObserver).toHaveBeenCalledExactlyOnceWith(
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
        if (completion === "handled failure") {
          await expect(f.owner.drain()).rejects.toBe(error);
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
});
