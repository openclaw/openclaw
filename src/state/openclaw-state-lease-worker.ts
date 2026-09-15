import type { DatabaseSync } from "node:sqlite";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import {
  OpenClawStateLeaseError,
  toOpenClawStateLeaseVerificationError,
} from "./openclaw-state-lease-error.js";
import {
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
