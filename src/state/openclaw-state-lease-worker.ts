import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runWithSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { stageSqliteTransactionState } from "../infra/sqlite-post-commit.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import {
  requestSqliteWorkerOperationAdmission,
  takeSqliteWorkerOperationAdmissionAttachment,
} from "../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import {
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  type OpenClawStateDatabase,
} from "./openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "./openclaw-state-db.js";
import type { OpenClawStateLeaseLifecycleOperations } from "./openclaw-state-lease-context.js";
import {
  OpenClawStateLeaseError,
  toOpenClawStateLeaseVerificationError,
} from "./openclaw-state-lease-error.js";
import { leaseHeartbeatState } from "./openclaw-state-lease-heartbeat-shared.js";
import { withLeaseWriteTransaction } from "./openclaw-state-lease-storage.js";
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
    attachment.observation.byteLength !==
      (leaseHeartbeatState.startupPhase + 1) * BigInt64Array.BYTES_PER_ELEMENT
  ) {
    throw new Error("State lease worker requires its original expiry observation attachment");
  }
  return new BigInt64Array(attachment.observation);
}

function publishLeaseExpiryObservation(shared: BigInt64Array, expiresAt: bigint): void {
  // Startup handoff joins every actor command before the independent worker takes over.
  if (Atomics.load(shared, leaseHeartbeatState.status) === leaseHeartbeatState.starting) {
    Atomics.store(shared, leaseHeartbeatState.expiresAt, expiresAt);
  }
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
        publishLeaseExpiryObservation(shared, value);
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
  stage: "transaction" | "commit" = "transaction",
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
    stage,
    facts: {
      kind: purpose === "write" ? "state-lease" : `state-lease-${purpose}`,
      identity,
      expiresAt,
    },
  });
  // The live owner grant can wait; expiry is sampled again on the held transaction.
  return readExpiry();
}

export function acquireOpenClawStateLeaseInWorker(
  input: OpenClawStateLeaseLifecycleOperations["stateLease.acquire"]["input"],
  databasePath: string,
  open: () => OpenClawStateDatabase,
) {
  const { identity, leaseMs, operationLabel, schemaPolicy } = input;
  const shared = input.observeExpiry ? takeLeaseExpiryObservation(identity) : undefined;
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
        const facts = { kind: "state-lease-acquire", identity };
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts });
        const result = acquireOpenClawStateLeaseInTransaction(db, identity, leaseMs);
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts });
        if (shared && result.kind === "acquired") {
          stageLeaseExpiryObservation(db, shared, result.expiresAt);
        }
        return result;
      },
      OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
    );
  } catch (cause) {
    throw new OpenClawStateLeaseError("State lease acquisition could not complete", {
      code: "OPENCLAW_STATE_LEASE_STORAGE_FAILED",
      cause,
    });
  }
}

export function executeOpenClawStateLeaseCommand(
  command: SqliteWorkerCommand<Omit<OpenClawStateLeaseLifecycleOperations, "stateLease.acquire">>,
  database: OpenClawStateDatabase,
): number | void {
  if (command.type === "stateLease.verify") {
    const shared = takeLeaseExpiryObservation(command.input.identity);
    const expiresAt = runSqliteDeferredTransactionSync(database.db, () =>
      assertOpenClawStateLeaseWorkerOwnedInTransaction(
        database.db,
        command.input.identity,
        "verify",
      ),
    );
    publishLeaseExpiryObservation(shared, BigInt(expiresAt));
    return expiresAt;
  }
  const shared =
    command.type === "stateLease.renew"
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
          assertOpenClawStateLeaseWorkerOwnedInTransaction(
            db,
            command.input.identity,
            "renew",
            "commit",
          );
          if (shared) {
            stageLeaseExpiryObservation(db, shared, expiresAt);
          }
          return expiresAt;
        }
        const facts = { kind: "state-lease-release", identity: command.input.identity };
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts });
        assertExistingDatabaseIdentity(database.path, command.input.databaseIdentity);
        releaseOpenClawStateLeaseInTransaction(db, command.input.identity);
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts });
        assertExistingDatabaseIdentity(database.path, command.input.databaseIdentity);
        return undefined;
      },
      { database, path: database.path, env: getSqliteWorkerStateContext().environment },
      { busyTimeoutMs: 0, operationLabel: command.input.operationLabel },
    ),
  );
}
