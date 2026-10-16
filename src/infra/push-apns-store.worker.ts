import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import type { WorkerOperationHandlers } from "../state/worker-operation-registry.js";
import { resolveNodePairingGeneration } from "./device-pairing-identity.js";
import { loadPairedDevicePairingStoreRecordFromDatabase } from "./device-pairing-store.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import {
  clearApnsRegistrationFromDatabase,
  nextApnsRegistrationVersion,
  readApnsRegistrationVersions,
} from "./push-apns-store-transaction.js";
import {
  readApnsRegistrationFromDatabase,
  readApnsRegistrationsFromDatabase,
} from "./push-apns-store.js";
import { apnsRegistrationToRow } from "./push-apns-store.rows.js";
import type { ApnsRegistration } from "./push-apns-store.types.js";
import { requestSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "./sqlite-worker-state-context.js";

type ApnsRegistrationDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "apns_registrations" | "apns_registration_tombstones"
>;

function apnsRegistrationsEqual(left: ApnsRegistration, right: ApnsRegistration): boolean {
  if (
    left.nodeId !== right.nodeId ||
    left.transport !== right.transport ||
    left.topic !== right.topic ||
    left.environment !== right.environment ||
    left.updatedAtMs !== right.updatedAtMs
  ) {
    return false;
  }
  if (left.transport === "direct" && right.transport === "direct") {
    return left.token === right.token;
  }
  return (
    left.transport === "relay" &&
    right.transport === "relay" &&
    left.relayHandle === right.relayHandle &&
    left.sendGrant === right.sendGrant &&
    left.installationId === right.installationId &&
    left.distribution === right.distribution &&
    left.relayOrigin === right.relayOrigin &&
    left.tokenDebugSuffix === right.tokenDebugSuffix
  );
}

type RegistrationResult =
  | { status: "pairing-changed" }
  | { status: "registered"; registration: ApnsRegistration };

function registerApnsRegistrationInDatabase(
  database: OpenClawStateDatabase,
  input: { candidate: ApnsRegistration; expectedPairingGeneration?: string; nowMs: number },
): RegistrationResult {
  const { candidate } = input;
  const { nodeId } = candidate;
  return runOpenClawStateWriteTransaction<RegistrationResult>(
    ({ db }) => {
      if (input.expectedPairingGeneration) {
        // The Gateway admission check happens before this transaction. Reread the
        // pairing here so removal and APNs ownership cannot commit out of order.
        const pairing = resolveNodePairingGeneration(
          loadPairedDevicePairingStoreRecordFromDatabase(db, nodeId),
        );
        if (pairing?.key !== input.expectedPairingGeneration) {
          return { status: "pairing-changed" };
        }
      }
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const stateDb = getNodeSqliteKysely<ApnsRegistrationDatabase>(db);
      // The tombstone carries the deleted row's successor version. Advancing past
      // both rows keeps stale compare-and-delete callers harmless after re-registration.
      const { previousVersions } = readApnsRegistrationVersions(db, nodeId);
      const next: ApnsRegistration = {
        ...candidate,
        updatedAtMs: nextApnsRegistrationVersion(nodeId, previousVersions, input.nowMs),
      };
      const row = apnsRegistrationToRow(next);
      const { node_id: _nodeId, ...updates } = row;
      executeSqliteQuerySync(
        db,
        stateDb
          .insertInto("apns_registrations")
          .values(row)
          .onConflict((conflict) => conflict.column("node_id").doUpdateSet(updates)),
      );
      executeSqliteQuerySync(
        db,
        stateDb.deleteFrom("apns_registration_tombstones").where("node_id", "=", nodeId),
      );
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      return { status: "registered", registration: next };
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
  );
}

export const apnsOperations = {
  "apns.registration.register": (
    input: Parameters<typeof registerApnsRegistrationInDatabase>[1],
    { open },
  ) => registerApnsRegistrationInDatabase(open(), input),
  "apns.registration.clearIfCurrent": (
    input: { nodeId: string; registration: ApnsRegistration; nowMs: number },
    { open },
  ) => {
    const database = open();
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        const { nodeId, registration, nowMs } = input;
        const current = readApnsRegistrationFromDatabase(db, nodeId);
        return Boolean(
          current &&
          apnsRegistrationsEqual(current, registration) &&
          clearApnsRegistrationFromDatabase(db, nodeId, nowMs),
        );
      },
      { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    );
  },
  "apns.registration.read": (input: string, { open }) =>
    readApnsRegistrationFromDatabase(open().db, input),
  "apns.registrations.read": (input: readonly string[], { open }) =>
    readApnsRegistrationsFromDatabase(open().db, input),
} satisfies WorkerOperationHandlers;
