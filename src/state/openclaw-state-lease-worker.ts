import type { DatabaseSync } from "node:sqlite";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import {
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  type OpenClawStateDatabase,
} from "./openclaw-state-db-contract.js";
import {
  OpenClawStateLeaseError,
  toOpenClawStateLeaseVerificationError,
} from "./openclaw-state-lease-error.js";
import { withLeaseWriteTransaction } from "./openclaw-state-lease-storage.js";
import {
  acquireOpenClawStateLeaseInTransaction,
  readOpenClawStateLeaseExpiry,
  type OpenClawStateLeaseIdentity,
} from "./openclaw-state-lease-store.js";

/** The live owner grants this exact transaction; the receipt alone grants nothing. */
export function assertOpenClawStateLeaseWorkerOwnedInTransaction(
  database: DatabaseSync,
  identity: OpenClawStateLeaseIdentity,
): void {
  if (!database.isTransaction) {
    throw new Error("State lease worker ownership requires an active write transaction");
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
    facts: { kind: "state-lease", identity, expiresAt },
  });
  // The live owner grant can wait; expiry is sampled again on the held transaction.
  readExpiry();
}

export function acquireOpenClawStateLeaseInWorker(
  input: {
    identity: OpenClawStateLeaseIdentity;
    leaseMs: number;
    operationLabel: string;
    schemaPolicy?: "existing";
  },
  databasePath: string,
  open: () => OpenClawStateDatabase,
) {
  const { identity, leaseMs, operationLabel, schemaPolicy } = input;
  try {
    return withLeaseWriteTransaction(
      {
        scope: "shared",
        schemaPolicy,
        options: {
          ...(schemaPolicy === "existing" ? {} : { database: open() }),
          path: databasePath,
          env: getSqliteWorkerStateContext().environment,
        },
      },
      operationLabel,
      (db) => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        const result = acquireOpenClawStateLeaseInTransaction(db, identity, leaseMs);
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        return result;
      },
      OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
    );
  } catch (cause) {
    // Preserve native contention facts through the worker's closed error transport.
    throw new OpenClawStateLeaseError("State lease acquisition could not complete", {
      code: "OPENCLAW_STATE_LEASE_STORAGE_FAILED",
      cause,
    });
  }
}
