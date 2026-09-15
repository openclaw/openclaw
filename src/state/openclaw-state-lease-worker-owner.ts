import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-coordinator.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionFactory,
} from "../infra/sqlite-worker-operation-admission.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { OpenClawStateWorkerLeaseContext } from "./openclaw-state-lease-context.js";
import { OpenClawStateLeaseError } from "./openclaw-state-lease-error.js";
import type { OpenClawStateLeaseIdentity } from "./openclaw-state-lease-store.js";

export type OpenClawStateLeaseWorkerPurpose = "write" | "acquire" | "verify" | "renew" | "release";

type WorkerLeaseScope = {
  identity: OpenClawStateLeaseIdentity;
  assertCurrent(this: void): void;
  createAdmission: SqliteWorkerAdmissionFactory;
};
type WorkerLeaseOwner = {
  run<T>(
    databasePath: string,
    operation: (scope: WorkerLeaseScope) => Promise<T>,
    purpose?: OpenClawStateLeaseWorkerPurpose,
  ): Promise<T>;
};
const owners = resolveGlobalSingleton(
  Symbol.for("openclaw.stateLeaseWorkerOwners"),
  () => new WeakMap<OpenClawStateWorkerLeaseContext, WorkerLeaseOwner>(),
);

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
  const owner: WorkerLeaseOwner = {
    run(databasePath, operation, purpose = "write") {
      assertCurrent(purpose);
      if (
        (!accepting && purpose !== "release" && purpose !== "verify") ||
        databasePath !== params.databasePath
      ) {
        throw new Error("State lease worker operation differs from its live owner");
      }
      let active = true;
      const assertScope = () => {
        assertCurrent(purpose);
        if (!active) {
          throw new Error("State lease worker operation has settled");
        }
      };
      const createAdmission: SqliteWorkerAdmissionFactory = (retained) => {
        assertScope();
        // Record custody before the grant port can be constructed or published.
        settlements.add(retained.settled);
        void retained.settled.then((settlement) => {
          if (settlement.kind === "unknown") {
            uncertain ??= { error: unknownOutcome(settlement.error) };
            accepting = false;
          }
          settlements.delete(retained.settled);
        });
        return {
          nativeLocations: [params.databasePath],
          admission: createSqliteWorkerOperationAdmission(
            (request, grant) => {
              assertScope();
              const facts = request.facts;
              if (
                request.stage !== "transaction" ||
                !isRecord(facts) ||
                facts.kind !== (purpose === "write" ? "state-lease" : `state-lease-${purpose}`) ||
                !isDeepStrictEqual(facts.identity, params.identity) ||
                ((purpose === "write" || purpose === "verify" || purpose === "renew") &&
                  (typeof facts.expiresAt !== "number" ||
                    !Number.isFinite(facts.expiresAt) ||
                    facts.expiresAt <= Date.now()))
              ) {
                throw new OpenClawStateLeaseError("State lease worker ownership was refused", {
                  code: "OPENCLAW_STATE_LEASE_LOST",
                });
              }
              grant();
            },
            params.expiryObservation &&
              (purpose === "acquire" || purpose === "verify" || purpose === "renew")
              ? {
                  kind: "state-lease-expiry",
                  identity: params.identity,
                  observation: params.expiryObservation,
                }
              : undefined,
          ),
        };
      };
      const result = (async () => {
        try {
          return await operation({
            identity: { ...params.identity },
            assertCurrent: assertScope,
            createAdmission,
          });
        } finally {
          active = false;
        }
      })();
      pending.add(result);
      void result.then(
        () => pending.delete(result),
        () => pending.delete(result),
      );
      return result;
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
      return owner.run(params.databasePath, operation);
    },
    canRelease: () => pending.size === 0 && settlements.size === 0 && !uncertain,
    settle,
    rethrowIfUncertain(failure: unknown, authorityError: unknown): void {
      if (!uncertain) {
        return;
      }
      const errors = [
        ...new Set([
          uncertain.error,
          failure,
          ...(authorityError === undefined ? [] : [authorityError]),
        ]),
      ];
      if (errors.length === 1) {
        throw uncertain.error;
      }
      throw unknownOutcome(
        createSqliteLifecycleAggregateError(
          errors,
          "state lease operation has an unknown write outcome",
          uncertain.error,
        ),
      );
    },
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
): Promise<T> {
  const owner = owners.get(lease);
  if (!owner) {
    throw new Error("State lease worker operation requires its original live lease context");
  }
  return owner.run(databasePath, operation);
}
