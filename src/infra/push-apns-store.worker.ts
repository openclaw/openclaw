import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveNodePairingGeneration } from "./device-pairing-identity.js";
import { loadPairedDevicePairingStoreRecordFromDatabase } from "./device-pairing-store.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { nextApnsRegistrationVersion } from "./push-apns-store-transaction.js";
import {
  readApnsRegistrationFromDatabase,
  readApnsRegistrationsFromDatabase,
} from "./push-apns-store.js";
import { apnsRegistrationToRow } from "./push-apns-store.rows.js";
import type { ApnsRegistration } from "./push-apns-store.types.js";
import type { ApnsRegistrationWorkerOperations } from "./push-apns-store.worker-contract.js";
import type { SqliteWorkerCommand } from "./sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "./sqlite-worker-state-context.js";

type ApnsRegistrationDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "apns_registrations" | "apns_registration_tombstones"
>;

function registerApnsRegistrationInDatabase(
  database: OpenClawStateDatabase,
  input: ApnsRegistrationWorkerOperations["apns.registration.register"]["input"],
): ApnsRegistrationWorkerOperations["apns.registration.register"]["output"] {
  const { candidate } = input;
  const { nodeId } = candidate;
  return runOpenClawStateWriteTransaction<
    ApnsRegistrationWorkerOperations["apns.registration.register"]["output"]
  >(
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
      const current = executeSqliteQueryTakeFirstSync(
        db,
        stateDb
          .selectFrom("apns_registrations")
          .select("updated_at_ms")
          .where("node_id", "=", nodeId),
      );
      const tombstone = executeSqliteQueryTakeFirstSync(
        db,
        stateDb
          .selectFrom("apns_registration_tombstones")
          .select("deleted_at_ms")
          .where("node_id", "=", nodeId),
      );
      // The tombstone carries the deleted row's successor version. Advancing past
      // both rows keeps stale compare-and-delete callers harmless after re-registration.
      const previousVersions = [current?.updated_at_ms, tombstone?.deleted_at_ms].filter(
        (version): version is number => version !== undefined,
      );
      const next: ApnsRegistration = {
        ...candidate,
        updatedAtMs: nextApnsRegistrationVersion(nodeId, previousVersions, input.nowMs),
      };
      const row = apnsRegistrationToRow(next);
      const {
        token,
        relay_handle,
        send_grant,
        installation_id,
        relay_origin,
        distribution,
        token_debug_suffix,
      } = row;
      executeSqliteQuerySync(
        db,
        stateDb
          .insertInto("apns_registrations")
          .values(row)
          .onConflict((conflict) =>
            conflict.column("node_id").doUpdateSet({
              transport: row.transport,
              token,
              relay_handle,
              send_grant,
              installation_id,
              relay_origin,
              topic: row.topic,
              environment: row.environment,
              distribution,
              token_debug_suffix,
              updated_at_ms: row.updated_at_ms,
            }),
          ),
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

export function executeApnsRegistrationCommand(
  command: SqliteWorkerCommand<ApnsRegistrationWorkerOperations>,
  database: OpenClawStateDatabase,
): ApnsRegistrationWorkerOperations[keyof ApnsRegistrationWorkerOperations]["output"] {
  switch (command.type) {
    case "apns.registration.register":
      return registerApnsRegistrationInDatabase(database, command.input);
    case "apns.registration.read":
      return readApnsRegistrationFromDatabase(database.db, command.input);
    case "apns.registrations.read":
      return readApnsRegistrationsFromDatabase(database.db, command.input);
  }
  throw new Error("Unsupported APNs registration command");
}
