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
    assertCurrent() {},
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
  ["transaction", "revoked"],
  ["transaction", "replacement"],
  ["transaction", "expired"],
  ["commit", "revoked"],
  ["commit", "expired"],
  ["commit", "allowed"],
] as const)("keeps authority live at %s: %s", async (stage, outcome) => {
  await using f = fixture();
  const withdrawn = new Error("Synthetic login was retired");
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const effects: string[] = [];
  let current = true;
  const prepare = (step: "transaction" | "commit") => {
    effects.push(step);
    if (stage !== step) {
      return;
    }
    if (outcome === "expired") {
      clock.mockReturnValue(now + 30_000);
    }
    if (outcome === "replacement") {
      throw withdrawn;
    }
  };
  const authority = {
    assertCurrent() {
      if (!current) {
        throw withdrawn;
      }
    },
    beforeTransaction: () => prepare("transaction"),
    beforeCommit: () => prepare("commit"),
  };
  if (outcome === "replacement") {
    f.lease.assertOwned = () => {
      authority.beforeTransaction = () => {};
    };
  }
  await f.run(async (scope) => {
    const { admission } = scope.createAdmission({ settled: f.settled.promise });
    const request = (step: "transaction" | "commit") =>
      requestLeaseAdmission(admission, step, {
        kind: "state-lease",
        identity: scope.identity,
        expiresAt: Date.now() + 30_000,
      });
    try {
      scope.assertCurrent();
      expect(effects).toEqual([]);
      if (stage === "commit") {
        expect(request("transaction")).toBe(1);
        expect(request("transaction")).toBe(1);
        expect(effects).toEqual(["transaction"]);
      }
      current = outcome !== "revoked";
      expect(request(stage)).toBe(outcome === "allowed" ? 1 : 2);
      const expectedEffects = stage === "commit" ? ["transaction"] : [];
      if (outcome !== "revoked") {
        expectedEffects.push(stage);
      }
      expect(effects).toEqual(expectedEffects);
      if (outcome === "expired") {
        expect(admission.failure).toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
      } else if (outcome !== "allowed") {
        expect(admission.failure).toBe(withdrawn);
      }
      // Acknowledgement remains deliverable after the commit grant.
      current = false;
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
    const commandCauses = completion === "reject" ? [commandError] : [];
    expect(collectNestedErrorCandidates(error)).toEqual(
      expect.arrayContaining([settlementError, ...commandCauses]),
    );
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
    expect(collectNestedErrorCandidates(combined)).toEqual(
      expect.arrayContaining([error, settlementError, authorityError, ...commandCauses]),
    );
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
