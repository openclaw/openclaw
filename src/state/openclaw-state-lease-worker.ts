import { hostname } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { stageSqliteTransactionState } from "../infra/sqlite-post-commit.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import {
  requestSqliteWorkerOperationAdmission,
  takeSqliteWorkerOperationAdmissionAttachment,
} from "../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import {
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  type OpenClawStateDatabase,
} from "./openclaw-state-db-contract.js";
import type { OpenClawStateLeaseLifecycleOperations } from "./openclaw-state-lease-context.js";
import {
  createOpenClawStateLeaseLostError,
  OpenClawStateLeaseError,
} from "./openclaw-state-lease-error.js";
import { leaseHeartbeatState } from "./openclaw-state-lease-heartbeat-shared.js";
import {
  verifyOpenClawStateLeaseOwnership,
  withLeaseWriteTransaction,
} from "./openclaw-state-lease-storage.js";
import {
  acquireOpenClawStateLeaseInTransaction,
  reclaimDeadOpenClawStateLeaseInTransaction,
  releaseOpenClawStateLeaseInTransaction,
  renewOpenClawStateLeaseInTransaction,
} from "./openclaw-state-lease-store.js";
import type { OpenClawStateLeaseIdentity } from "./openclaw-state-lease.types.js";

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

function readOwnedLeaseExpiry(
  database: DatabaseSync,
  identity: OpenClawStateLeaseIdentity,
): number {
  return verifyOpenClawStateLeaseOwnership({
    ...identity,
    leaseLabel: "state lease",
    transaction: database,
  });
}

function assertOpenClawStateLeaseWorkerOwned(
  database: DatabaseSync,
  identity: OpenClawStateLeaseIdentity,
  purpose: "write" | "verify" | "renew" = "write",
  stage: "transaction" | "commit" = "transaction",
  domainFacts?: unknown,
): number {
  const expiresAt = readOwnedLeaseExpiry(database, identity);
  requestSqliteWorkerOperationAdmission({
    stage,
    facts: {
      kind: purpose === "write" ? "state-lease" : `state-lease-${purpose}`,
      identity,
      expiresAt,
      ...(domainFacts === undefined ? {} : { domainFacts }),
    },
  });
  // Host admission can wait; verify again before publishing the observed expiry.
  return readOwnedLeaseExpiry(database, identity);
}

/** The live owner grants this exact transaction; the receipt alone grants nothing. */
export function assertOpenClawStateLeaseWorkerOwnedInTransaction(
  database: DatabaseSync,
  identity: OpenClawStateLeaseIdentity,
  purpose: "write" | "verify" | "renew" = "write",
  stage: "transaction" | "commit" = "transaction",
  domainFacts?: unknown,
): number {
  if (!database.isTransaction) {
    throw new Error("State lease worker ownership requires an active transaction");
  }
  return assertOpenClawStateLeaseWorkerOwned(database, identity, purpose, stage, domainFacts);
}

/** One grant covers the complete lease set held by this transaction. */
export function assertOpenClawStateLeasesWorkerOwnedInTransaction(
  database: DatabaseSync,
  identities: readonly OpenClawStateLeaseIdentity[],
  stage: "transaction" | "commit" = "transaction",
): void {
  if (!database.isTransaction) {
    throw new Error("State lease worker ownership requires an active transaction");
  }
  const keys = new Set(identities.map(({ scope, key }) => JSON.stringify([scope, key])));
  if (identities.length === 0 || keys.size !== identities.length) {
    throw new Error("State lease worker transaction requires distinct live leases");
  }
  const leases = identities.map((identity) => ({
    identity,
    expiresAt: readOwnedLeaseExpiry(database, identity),
  }));
  requestSqliteWorkerOperationAdmission({ stage, facts: { kind: "state-leases", leases } });
  for (const identity of identities) {
    readOwnedLeaseExpiry(database, identity);
  }
}

export function acquireOpenClawStateLeaseInWorker(
  input: OpenClawStateLeaseLifecycleOperations["stateLease.acquire"]["input"],
  databasePath: string,
  open: () => OpenClawStateDatabase,
) {
  const { identity, leaseMs, operationLabel, schemaPolicy } = input;
  const shared = input.observeExpiry ? takeLeaseExpiryObservation(identity) : undefined;
  // Worker threads share the process lifetime; arbitrary subprocess work does not.
  const payloadJson = input.processBound
    ? JSON.stringify({
        owner: {
          pid: process.pid,
          host: hostname(),
          startedAt: getFileLockProcessStartTime(
            process.pid,
            getSqliteWorkerStateContext().environment,
          ),
        },
      })
    : null;
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
      operationLabel === "state.lease" ? "state.lease.acquire" : operationLabel,
      (db) => {
        const facts = { kind: "state-lease-acquire", identity };
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts });
        reclaimDeadOpenClawStateLeaseInTransaction(db, identity);
        const result = acquireOpenClawStateLeaseInTransaction(db, identity, leaseMs, payloadJson);
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
    // Each SELECT owns its snapshot; host scheduling must not pin the WAL or stale the reread.
    const expiresAt = assertOpenClawStateLeaseWorkerOwned(
      database.db,
      command.input.identity,
      "verify",
    );
    publishLeaseExpiryObservation(shared, BigInt(expiresAt));
    return expiresAt;
  }
  const shared =
    command.type === "stateLease.renew"
      ? takeLeaseExpiryObservation(command.input.identity)
      : undefined;
  return withLeaseWriteTransaction(
    {
      scope: "shared",
      options: { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    },
    command.input.operationLabel !== "state.lease"
      ? command.input.operationLabel
      : command.type === "stateLease.renew"
        ? "state.lease.renew"
        : "state.lease.release",
    (db) => {
      if (command.type === "stateLease.renew") {
        assertOpenClawStateLeaseWorkerOwnedInTransaction(db, command.input.identity, "renew");
        const expiresAt = renewOpenClawStateLeaseInTransaction(
          db,
          command.input.identity,
          command.input.leaseMs,
        );
        if (expiresAt === undefined) {
          throw createOpenClawStateLeaseLostError(command.input.identity);
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
  );
}
