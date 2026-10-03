import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import type { WorkerOperationContext } from "../state/worker-operation-registry.js";
import { prepareDevicePairingBinding } from "./device-pairing-binding.js";
import { withDevicePairingMutationAdmission } from "./device-pairing-mutation.worker.js";
import type { DevicePairingCommitReceipt } from "./device-pairing-read.types.js";
import { resolveDevicePairingStoreRevision } from "./device-pairing-store-cache.js";
import {
  readPairedDevicePairingRecordsFromDatabase,
  withDevicePairingStoreDatabase,
} from "./device-pairing-store.js";
import { deferSqliteWorkerCommitReceipt } from "./sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "./sqlite-worker-state-context.js";

type DevicePairingMutationContext = {
  database: OpenClawStateDatabase;
  recordTokenReplacement: (
    facts: NonNullable<DevicePairingCommitReceipt["tokensReplaced"]>,
  ) => void;
  recordWorkerEnvironment: (
    facts: NonNullable<DevicePairingCommitReceipt["workerEnvironment"]>,
  ) => void;
};

export function devicePairingMutation<Input, Result>(
  operation: (input: Input, context: DevicePairingMutationContext) => Result,
) {
  return (input: Input, { open }: WorkerOperationContext): Result => {
    const database = open();
    return runOpenClawStateWriteTransaction(
      () =>
        withDevicePairingStoreDatabase(database, () =>
          withDevicePairingMutationAdmission(() => {
            const before = readPairedDevicePairingRecordsFromDatabase(database.db);
            let tokensReplaced: DevicePairingCommitReceipt["tokensReplaced"];
            let workerEnvironment: DevicePairingCommitReceipt["workerEnvironment"];
            const result = operation(input, {
              database,
              recordTokenReplacement: (facts) => {
                tokensReplaced = facts;
              },
              recordWorkerEnvironment: (facts) => {
                workerEnvironment = facts;
              },
            });
            const after = readPairedDevicePairingRecordsFromDatabase(database.db);
            const changed: DevicePairingCommitReceipt["changed"] = [];
            for (const deviceId of new Set([...Object.keys(before), ...Object.keys(after)])) {
              if (JSON.stringify(before[deviceId]) !== JSON.stringify(after[deviceId])) {
                changed.push(prepareDevicePairingBinding(deviceId, after[deviceId] ?? null));
              }
            }
            deferSqliteWorkerCommitReceipt(database.db, {
              kind: "devicePairing",
              beforeRevision: resolveDevicePairingStoreRevision(before),
              revision: resolveDevicePairingStoreRevision(after),
              changed,
              ...(tokensReplaced ? { tokensReplaced } : {}),
              ...(workerEnvironment ? { workerEnvironment } : {}),
            } satisfies DevicePairingCommitReceipt);
            return result;
          }),
        ),
      { database, env: getSqliteWorkerStateContext().environment },
    );
  };
}
