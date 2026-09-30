import { isDeepStrictEqual } from "node:util";
import {
  collectNestedErrorCandidates,
  extractErrorCode,
} from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-lifecycle-errors.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionFactory,
} from "../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../infra/sqlite-worker-operation-settlement.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { OpenClawStateWorkerLeaseContext } from "./openclaw-state-lease-context.js";
import { OpenClawStateLeaseError } from "./openclaw-state-lease-error.js";
import type { OpenClawStateLeaseIdentity } from "./openclaw-state-lease-store.js";

export type OpenClawStateLeaseWorkerPurpose = "write" | "acquire" | "verify" | "renew" | "release";

export type OpenClawStateLeaseWorkerAuthority = {
  assertCurrent(this: void): void;
  beforeCommit?(this: void): void;
};

export type WorkerLeaseScope = {
  identity: OpenClawStateLeaseIdentity;
  assertCurrent(this: void): void;
  createAdmission: SqliteWorkerAdmissionFactory;
};
type RetainedLeaseScope = {
  identity: OpenClawStateLeaseIdentity;
  databasePath: string;
  assertCurrent(this: void): void;
  retainSettlement(settled: Promise<SqliteWorkerOperationSettlement>): void;
  settleNative(
    settled: Promise<SqliteWorkerOperationSettlement>,
    outcome: SqliteWorkerOperationSettlement,
  ): void;
  rethrowIfUncertain(failure: unknown, authorityError: unknown): void;
  finish(): void;
};
type WorkerLeaseOwner = {
  identity: OpenClawStateLeaseIdentity;
  retain(
    databasePath: string,
    purpose: OpenClawStateLeaseWorkerPurpose,
    authority?: OpenClawStateLeaseWorkerAuthority,
  ): RetainedLeaseScope;
  run<T>(
    databasePath: string,
    operation: (scope: WorkerLeaseScope) => Promise<T>,
    purpose: OpenClawStateLeaseWorkerPurpose,
    authority?: OpenClawStateLeaseWorkerAuthority,
  ): Promise<T>;
};
const owners = resolveGlobalSingleton(
  Symbol.for("openclaw.stateLeaseWorkerOwners"),
  () => new WeakMap<OpenClawStateWorkerLeaseContext, WorkerLeaseOwner>(),
);

function ownershipRefused(): never {
  throw new OpenClawStateLeaseError("State lease worker ownership was refused", {
    code: "OPENCLAW_STATE_LEASE_LOST",
  });
}

function createLeaseAdmissionFactory(
  scopes: readonly RetainedLeaseScope[],
  purpose: OpenClawStateLeaseWorkerPurpose,
  assertCurrent: () => void,
  beforeCommit?: () => void,
  options: { expiryObservation?: SharedArrayBuffer } = {},
): SqliteWorkerAdmissionFactory {
  const firstScope = scopes[0];
  if (!firstScope) {
    throw new Error("State lease admission requires a retained owner");
  }
  return (retained) => {
    assertCurrent();
    // All original owners retain the same native outcome before a port can escape.
    for (const scope of scopes) {
      scope.retainSettlement(retained.settled);
    }
    void retained.settled.then((outcome) => {
      // Poison every participating owner in one turn before any release can observe settlement.
      for (const scope of scopes) {
        scope.settleNative(retained.settled, outcome);
      }
    });
    let writeStage: "waiting" | "transaction" | "commit" = "waiting";
    let lifecycleStage: "transaction" | "commit" | "settled" = "transaction";
    const lifecycleWrite = purpose === "acquire" || purpose === "renew" || purpose === "release";
    const expiryRequired = purpose === "write" || purpose === "verify" || purpose === "renew";
    return {
      nativeLocations: [...new Set(scopes.map((scope) => scope.databasePath))],
      admission: createSqliteWorkerOperationAdmission(
        (request, grant) => {
          assertCurrent();
          const facts = request.facts;
          const kind = purpose === "write" ? "state-lease" : `state-lease-${purpose}`;
          if (
            (purpose === "write"
              ? writeStage === "commit" ||
                (request.stage !== "transaction" &&
                  !(request.stage === "commit" && writeStage === "transaction"))
              : lifecycleWrite
                ? request.stage !== lifecycleStage
                : request.stage !== "transaction") ||
            !isRecord(facts) ||
            facts.kind !== kind
          ) {
            ownershipRefused();
          }
          const assertFacts = () => {
            const now = Date.now();
            for (const scope of scopes) {
              if (
                !isDeepStrictEqual(facts.identity, scope.identity) ||
                (expiryRequired &&
                  (typeof facts.expiresAt !== "number" ||
                    !Number.isFinite(facts.expiresAt) ||
                    facts.expiresAt <= now))
              ) {
                ownershipRefused();
              }
            }
          };
          assertFacts();
          if (purpose === "write" && request.stage === "commit") {
            writeStage = "commit";
            beforeCommit?.();
            assertCurrent();
            // Synchronous host work can consume the worker's remaining lease lifetime.
            assertFacts();
          }
          if (grant()) {
            if (lifecycleWrite) {
              lifecycleStage = lifecycleStage === "transaction" ? "commit" : "settled";
            } else if (purpose === "write" && request.stage === "transaction") {
              writeStage = "transaction";
            }
          }
        },
        options.expiryObservation &&
          (purpose === "acquire" || purpose === "verify" || purpose === "renew")
          ? {
              kind: "state-lease-expiry",
              identity: firstScope.identity,
              observation: options.expiryObservation,
            }
          : undefined,
      ),
    };
  };
}

function runRetainedLeaseScopes<T>(
  scopes: readonly RetainedLeaseScope[],
  operation: () => Promise<T>,
): Promise<T> {
  const result = (async () => {
    try {
      const value = await operation();
      for (const scope of scopes) {
        scope.rethrowIfUncertain(undefined, undefined);
      }
      return value;
    } catch (failure) {
      for (const scope of scopes) {
        scope.rethrowIfUncertain(failure, undefined);
      }
      throw failure;
    } finally {
      for (const scope of scopes) {
        scope.finish();
      }
    }
  })();
  // Custody also owns abandoned failures; callers still receive the original rejecting result.
  void result.catch(() => {});
  return result;
}

/** Registered only by the actual lease owner, never reconstructed from a receipt. */
export function createOpenClawStateLeaseWorkerOwner(params: {
  lease?: OpenClawStateWorkerLeaseContext;
  identity: OpenClawStateLeaseIdentity;
  databasePath: string;
  expiryObservation?: SharedArrayBuffer;
  assertCurrent(purpose: OpenClawStateLeaseWorkerPurpose): void;
}) {
  const pending = new Set<Promise<unknown>>();
  const settlements = new Set<Promise<unknown>>();
  let accepting = true;
  let closed = false;
  let uncertain: { error: SqliteWorkerError } | undefined;
  const unknownOutcome = (cause: unknown) =>
    Object.assign(
      new SqliteWorkerError("State lease worker transaction outcome is unknown", "outcome-unknown"),
      { cause },
    );
  const assertCurrent = (purpose: OpenClawStateLeaseWorkerPurpose) => {
    if (uncertain) {
      throw uncertain.error;
    }
    if (closed) {
      throw new OpenClawStateLeaseError("State lease worker admission is closed", {
        code: "OPENCLAW_STATE_LEASE_LOST",
      });
    }
    params.assertCurrent(purpose);
  };
  const rethrowIfUncertain = (failure: unknown, authorityError: unknown): void => {
    const uncertainty =
      uncertain?.error ??
      collectNestedErrorCandidates(failure).find(
        (candidate) => extractErrorCode(candidate) === "outcome-unknown",
      );
    if (uncertainty === undefined) {
      return;
    }
    const errors = [
      ...new Set(
        [uncertainty, failure, ...(authorityError === undefined ? [] : [authorityError])].filter(
          (error) => error !== undefined,
        ),
      ),
    ];
    if (errors.length === 1) {
      throw uncertainty instanceof Error ? uncertainty : unknownOutcome(uncertainty);
    }
    throw unknownOutcome(
      createSqliteLifecycleAggregateError(
        errors,
        "state lease operation has an unknown write outcome",
        uncertainty,
      ),
    );
  };
  const owner: WorkerLeaseOwner = {
    identity: params.identity,
    retain(databasePath, purpose, authority) {
      const assertCaller = authority?.assertCurrent;
      assertCurrent(purpose);
      if (
        (!accepting && purpose !== "release" && purpose !== "verify") ||
        databasePath !== params.databasePath
      ) {
        throw new Error("State lease worker operation differs from its live owner");
      }
      const completion = createDeferredCore();
      pending.add(completion.promise);
      let active = true;
      return {
        identity: params.identity,
        databasePath: params.databasePath,
        assertCurrent() {
          assertCurrent(purpose);
          assertCaller?.();
          if (!active) {
            throw new Error("State lease worker operation has settled");
          }
        },
        retainSettlement(settled) {
          settlements.add(settled);
        },
        settleNative(settled, settlement) {
          if (settlement.kind === "unknown") {
            uncertain ??= { error: unknownOutcome(settlement.error) };
            accepting = false;
          }
          settlements.delete(settled);
        },
        rethrowIfUncertain,
        finish() {
          active = false;
          pending.delete(completion.promise);
          completion.resolve();
        },
      };
    },
    run(databasePath, operation, purpose, authority) {
      const beforeCommit = authority?.beforeCommit;
      const scope = owner.retain(databasePath, purpose, authority);
      return runRetainedLeaseScopes([scope], () =>
        operation({
          identity: { ...scope.identity },
          assertCurrent: scope.assertCurrent,
          createAdmission: createLeaseAdmissionFactory(
            [scope],
            purpose,
            scope.assertCurrent,
            beforeCommit,
            { expiryObservation: params.expiryObservation },
          ),
        }),
      );
    },
  };
  let boundLease = params.lease;
  if (boundLease) {
    owners.set(boundLease, owner);
  }
  const settle = async () => {
    accepting = false;
    await Promise.allSettled(pending);
    await Promise.allSettled(settlements);
  };
  return {
    bind(lease: OpenClawStateWorkerLeaseContext) {
      if (closed || boundLease) {
        throw new Error("State lease worker owner is already bound or closed");
      }
      boundLease = lease;
      owners.set(lease, owner);
    },
    runLifecycle<T>(
      purpose: "acquire" | "verify" | "renew" | "release",
      operation: (scope: WorkerLeaseScope) => Promise<T>,
    ): Promise<T> {
      return owner.run(params.databasePath, operation, purpose);
    },
    run<T>(operation: () => Promise<T>): Promise<T> {
      return owner.run(params.databasePath, operation, "write");
    },
    canRelease: () => pending.size === 0 && settlements.size === 0 && !uncertain,
    settle,
    rethrowIfUncertain,
    async drain() {
      await settle();
      if (uncertain) {
        throw uncertain.error;
      }
    },
    close() {
      accepting = false;
      closed = true;
      if (boundLease) {
        owners.delete(boundLease);
      }
    },
  };
}

export function withOpenClawStateLeaseWorkerAdmission<T>(
  lease: OpenClawStateWorkerLeaseContext,
  databasePath: string,
  operation: (scope: WorkerLeaseScope) => Promise<T>,
  authority?: OpenClawStateLeaseWorkerAuthority,
): Promise<T> {
  const owner = owners.get(lease);
  if (!owner) {
    throw new Error("State lease worker operation requires its original live lease context");
  }
  return owner.run(databasePath, operation, "write", authority);
}
