import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runWithSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { stageSqliteTransactionState } from "../infra/sqlite-post-commit.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import {
  requestSqliteWorkerOperationAdmission,
  takeSqliteWorkerOperationAdmissionAttachment,
} from "../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "./openclaw-state-db.js";
import type { OpenClawStateLeaseLifecycleOperations } from "./openclaw-state-lease-context.js";
import {
  OpenClawStateLeaseError,
  toOpenClawStateLeaseVerificationError,
} from "./openclaw-state-lease-error.js";
import { leaseHeartbeatState } from "./openclaw-state-lease-heartbeat-shared.js";
import {
  acquireOpenClawStateLeaseInTransaction,
  readOpenClawStateLeaseExpiry,
  releaseOpenClawStateLeaseInTransaction,
  renewOpenClawStateLeaseInTransaction,
  type OpenClawStateLeaseIdentity,
} from "./openclaw-state-lease-store.js";

function takeLeaseExpiryObservation(identity: OpenClawStateLeaseIdentity): BigInt64Array {
  const attachment = takeSqliteWorkerOperationAdmissionAttachment();
  if (
    !isRecord(attachment) ||
    attachment.kind !== "state-lease-expiry" ||
    !isDeepStrictEqual(attachment.identity, identity) ||
    !(attachment.observation instanceof SharedArrayBuffer) ||
    attachment.observation.byteLength !== 4 * BigInt64Array.BYTES_PER_ELEMENT
  ) {
    throw new Error("State lease worker requires its original expiry observation attachment");
  }
  return new BigInt64Array(attachment.observation);
}

function stageLeaseExpiryObservation(
  db: DatabaseSync,
  shared: BigInt64Array,
  expiresAt: number | undefined,
): void {
  const value = BigInt(expiresAt ?? 0);
  if (
    !stageSqliteTransactionState(db, {
      stage() {},
      rollback() {},
      commit() {
        Atomics.store(shared, leaseHeartbeatState.expiresAt, value);
      },
    })
  ) {
    throw new Error("State lease expiry observation requires a coordinated transaction");
  }
}

/** The live owner grants this exact transaction; the receipt alone grants nothing. */
export function assertOpenClawStateLeaseWorkerOwnedInTransaction(
  database: DatabaseSync,
  identity: OpenClawStateLeaseIdentity,
  purpose: "write" | "verify" | "renew" = "write",
): number {
  if (!database.isTransaction) {
    throw new Error("State lease worker ownership requires an active transaction");
  }
  const readExpiry = () => {
    try {
      const expiresAt = readOpenClawStateLeaseExpiry(database, identity);
      if (expiresAt === undefined) {
        throw new OpenClawStateLeaseError(
          `state lease ${identity.scope}/${identity.key} was lost`,
          {
            code: "OPENCLAW_STATE_LEASE_LOST",
          },
        );
      }
      return expiresAt;
    } catch (error) {
      throw toOpenClawStateLeaseVerificationError(identity, error);
    }
  };
  const expiresAt = readExpiry();
  requestSqliteWorkerOperationAdmission({
    stage: "transaction",
    facts: {
      kind: purpose === "write" ? "state-lease" : `state-lease-${purpose}`,
      identity,
      expiresAt,
    },
  });
  // The live owner grant can wait; expiry is sampled again on the held transaction.
  return readExpiry();
}

export function executeOpenClawStateLeaseCommand(
  command: SqliteWorkerCommand<OpenClawStateLeaseLifecycleOperations>,
  database: OpenClawStateDatabase,
): number | undefined | void {
  if (command.type === "stateLease.verify") {
    const shared = takeLeaseExpiryObservation(command.input.identity);
    const expiresAt = runSqliteDeferredTransactionSync(database.db, () =>
      assertOpenClawStateLeaseWorkerOwnedInTransaction(
        database.db,
        command.input.identity,
        "verify",
      ),
    );
    Atomics.store(shared, leaseHeartbeatState.expiresAt, BigInt(expiresAt));
    return expiresAt;
  }
  const shared =
    command.type === "stateLease.renew" ||
    (command.type === "stateLease.acquire" && command.input.observeExpiry)
      ? takeLeaseExpiryObservation(command.input.identity)
      : undefined;
  return runWithSqliteBusyTimeout(database.db, 0, () =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        if (command.type === "stateLease.renew") {
          assertOpenClawStateLeaseWorkerOwnedInTransaction(db, command.input.identity, "renew");
          const expiresAt = renewOpenClawStateLeaseInTransaction(
            db,
            command.input.identity,
            command.input.leaseMs,
          );
          if (expiresAt === undefined) {
            throw new OpenClawStateLeaseError(
              `state lease ${command.input.identity.scope}/${command.input.identity.key} was lost`,
              { code: "OPENCLAW_STATE_LEASE_LOST" },
            );
          }
          if (shared) {
            stageLeaseExpiryObservation(db, shared, expiresAt);
          }
          return expiresAt;
        }
        requestSqliteWorkerOperationAdmission({
          stage: "transaction",
          facts: {
            kind:
              command.type === "stateLease.acquire" ? "state-lease-acquire" : "state-lease-release",
            identity: command.input.identity,
          },
        });
        if (command.type === "stateLease.acquire") {
          const expiresAt = acquireOpenClawStateLeaseInTransaction(
            db,
            command.input.identity,
            command.input.leaseMs,
          );
          if (shared) {
            stageLeaseExpiryObservation(db, shared, expiresAt);
          }
          return expiresAt;
        }
        releaseOpenClawStateLeaseInTransaction(db, command.input.identity);
        return undefined;
      },
      {
        database,
        path: database.path,
        env: getSqliteWorkerStateContext().environment,
      },
      { busyTimeoutMs: 0, operationLabel: command.input.operationLabel },
    ),
  );
}
