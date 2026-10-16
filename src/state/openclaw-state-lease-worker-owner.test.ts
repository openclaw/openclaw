import { setImmediate } from "node:timers/promises";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { afterEach, expect, it, vi } from "vitest";
import type { SqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../infra/sqlite-worker-operation-settlement.js";
import { createDeferredCore } from "../shared/deferred.js";
import { requestLeaseAdmission } from "./openclaw-state-lease-admission.test-support.js";
import type { OpenClawStateLeaseContext } from "./openclaw-state-lease-context.js";
import { OpenClawStateLeaseError } from "./openclaw-state-lease-error.js";
import {
  createOpenClawStateLeaseWorkerOwner,
  withOpenClawStateLeaseWorkerAdmission,
  type OpenClawStateLeaseWorkerAuthority,
  type WorkerLeaseScope,
} from "./openclaw-state-lease-worker-owner.js";

const forbiddenSqlite = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("Worker owner boundary tests must not open SQLite");
  }),
);
vi.mock("../infra/node-sqlite.js", () => ({ openNodeSqliteDatabase: forbiddenSqlite }));

afterEach(() => {
  vi.restoreAllMocks();
  expect(forbiddenSqlite).not.toHaveBeenCalled();
});

function fixture(uncertain = false) {
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
  const settled = createDeferredCore<SqliteWorkerOperationSettlement>();
  const result = {
    lease,
    owner,
    settled,
    async [Symbol.asyncDispose]() {
      settled.resolve({ kind: "completed" });
      try {
        await (uncertain ? owner.settle() : owner.drain());
      } finally {
        owner.close();
      }
    },
    run<T>(
      operation: (scope: WorkerLeaseScope) => Promise<T>,
      authority?: OpenClawStateLeaseWorkerAuthority,
    ): Promise<T> {
      return withOpenClawStateLeaseWorkerAdmission(lease, databasePath, operation, authority);
    },
    async admitted<T>(
      operation: (admission: SqliteWorkerOperationAdmission) => T,
    ): Promise<Awaited<T>> {
      return await result.run(async (scope) => {
        const { admission } = scope.createAdmission({ settled: settled.promise });
        try {
          return await operation(admission);
        } finally {
          admission.finish();
        }
      });
    },
  };
  return result;
}

it.each([
  "none",
  "transaction",
  "commit",
  "beforeTransaction replacement",
  "beforeTransaction expiry",
  "beforeCommit expiry",
] as const)("keeps caller authority and expiry live through commit (%s)", async (withdrawAt) => {
  await using f = fixture();
  const expireCommit = withdrawAt === "beforeCommit expiry";
  const expireTransaction = withdrawAt === "beforeTransaction expiry";
  const replaceGuard = withdrawAt === "beforeTransaction replacement";
  const withdrawn = new Error("Synthetic login was retired");
  const now = Date.now();
  const clock =
    expireCommit || expireTransaction ? vi.spyOn(Date, "now").mockReturnValue(now) : undefined;
  const beforeTransaction = vi.fn(() => {
    if (replaceGuard) {
      throw withdrawn;
    }
    if (expireTransaction) {
      clock?.mockReturnValue(now + 30_000);
    }
  });
  const beforeCommit = vi.fn(() => {
    clock?.mockReturnValue(now + 30_000);
  });
  let current = true;
  const authority = {
    assertCurrent() {
      if (!current) {
        throw withdrawn;
      }
    },
    beforeTransaction,
    beforeCommit,
  };
  if (replaceGuard) {
    const replacement = vi.fn();
    f.lease.assertOwned = () => {
      authority.beforeTransaction = replacement;
    };
  }
  await f.run(async (scope) => {
    const { admission } = scope.createAdmission({ settled: f.settled.promise });
    scope.assertCurrent();
    expect(beforeTransaction).not.toHaveBeenCalled();
    expect(beforeCommit).not.toHaveBeenCalled();
    const request = (stage: "transaction" | "commit") =>
      requestLeaseAdmission(admission, stage, {
        kind: "state-lease",
        identity: scope.identity,
        expiresAt: Date.now() + 30_000,
      });
    try {
      current = withdrawAt !== "transaction";
      expect(request("transaction")).toBe(current && !expireTransaction && !replaceGuard ? 1 : 2);
      expect(beforeCommit).not.toHaveBeenCalled();
      if (!current || replaceGuard) {
        expect(admission.failure).toBe(withdrawn);
        if (replaceGuard) {
          expect(beforeTransaction).toHaveBeenCalledOnce();
        }
        return;
      }
      expect(beforeTransaction).toHaveBeenCalledOnce();
      if (expireTransaction) {
        expect(admission.failure).toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
        return;
      }
      // One bounded mutation can verify its lease before several statements.
      expect(request("transaction")).toBe(1);
      expect(beforeTransaction).toHaveBeenCalledOnce();
      current = withdrawAt !== "commit";
      expect(request("commit")).toBe(current && !expireCommit ? 1 : 2);
      if (current) {
        expect(beforeCommit).toHaveBeenCalledOnce();
        if (expireCommit) {
          expect(admission.failure).toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
        }
        // Acknowledgement remains deliverable after the commit grant.
        current = false;
      } else {
        expect(beforeCommit).not.toHaveBeenCalled();
        expect(admission.failure).toBe(withdrawn);
      }
    } finally {
      admission.finish();
      f.settled.resolve({ kind: "completed" });
    }
  }, authority);
});

it.each(["reject", "handled failure"] as const)(
  "reports unknown settlement before a caller observes %s",
  async (completion) => {
    await using f = fixture(true);
    const settlementError = new Error("Synthetic command settlement is unknown");
    const commandError = new Error("Synthetic command delivery failed");
    const nextOperation = vi.fn(async () => "continued");
    const operation = f.admitted(async () => {
      // The broker publishes native settlement before delivering the command result.
      f.settled.resolve({ kind: "unknown", error: settlementError });
      if (completion === "handled failure") {
        await Promise.reject(commandError).catch(() => undefined);
        return "handled";
      }
      throw commandError;
    });
    const error: unknown = await operation.catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "outcome-unknown" });
    const causes = collectNestedErrorCandidates(error);
    expect(causes).toContain(settlementError);
    if (completion === "reject") {
      expect(causes).toContain(commandError);
    }
    expect(f.owner.canRelease()).toBe(false);
    await expect(Promise.resolve().then(() => f.run(nextOperation))).rejects.toMatchObject({
      code: "outcome-unknown",
    });
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
    await expect(f.owner.drain()).rejects.toMatchObject({ code: "outcome-unknown" });
  },
);

it.each(["completed", "not-entered"] as const)(
  "preserves the exact original failure for %s settlement",
  async (kind) => {
    await using f = fixture();
    const commandError = new Error("Synthetic known command failure");
    const nextOperation = vi.fn(async () => "continued");
    const operation = f.admitted(() => {
      f.settled.resolve(kind === "completed" ? { kind } : { kind, error: commandError });
      throw commandError;
    });
    await expect(operation).rejects.toBe(commandError);
    expect(f.owner.canRelease()).toBe(true);
    await expect(f.run(nextOperation)).resolves.toBe("continued");
    expect(nextOperation).toHaveBeenCalledOnce();
  },
);

it("joins retained settlement after the callback completes and closes further admission", async () => {
  await using f = fixture();
  const nextOperation = vi.fn(async () => "continued");
  await expect(f.admitted(() => "completed callback")).resolves.toBe("completed callback");
  expect(f.owner.canRelease()).toBe(false);
  let drained = false;
  const drain = f.owner.drain().then(() => {
    drained = true;
  });
  // An event-loop turn flushes promise continuations without timing a native operation.
  await setImmediate();
  expect(drained).toBe(false);
  await expect(Promise.resolve().then(() => f.run(nextOperation))).rejects.toThrow();
  expect(nextOperation).not.toHaveBeenCalled();
  f.settled.resolve({ kind: "completed" });
  await drain;
  expect(drained).toBe(true);
  expect(f.owner.canRelease()).toBe(true);
});
