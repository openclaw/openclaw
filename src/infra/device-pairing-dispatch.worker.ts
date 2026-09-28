import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { executeDeviceBootstrapMutation } from "./device-bootstrap.worker-kernel.js";
import { prepareDevicePairingBinding } from "./device-pairing-binding.js";
import { executeDevicePairingCoreMutation } from "./device-pairing-core.worker.js";
import { withDevicePairingMutationAdmission } from "./device-pairing-mutation.worker.js";
import { executeDevicePairingNodeMutation } from "./device-pairing-node.worker.js";
import type { DevicePairingCommitReceipt } from "./device-pairing-read.types.js";
import { resolveDevicePairingStoreRevision } from "./device-pairing-store-cache.js";
import {
  readPairedDevicePairingRecordsFromDatabase,
  withDevicePairingStoreDatabase,
} from "./device-pairing-store.js";
import type { DevicePairingMutationCommand } from "./device-pairing-worker-contract.js";
import { deferSqliteWorkerCommitReceipt } from "./sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "./sqlite-worker-state-context.js";

function execute(
  command: DevicePairingMutationCommand,
  database: OpenClawStateDatabase,
  recordTokenReplacement: (
    facts: NonNullable<DevicePairingCommitReceipt["tokensReplaced"]>,
  ) => void,
  recordWorkerEnvironment: (
    facts: NonNullable<DevicePairingCommitReceipt["workerEnvironment"]>,
  ) => void,
) {
  switch (command.type) {
    case "devicePairing.request":
    case "devicePairing.reject":
    case "devicePairing.remove":
    case "devicePairing.pruneSilent":
    case "devicePairing.removeRole":
    case "devicePairing.updateMetadata":
    case "devicePairing.updatePresence":
    case "devicePairing.approve":
    case "devicePairing.verifyToken":
    case "devicePairing.ensureToken":
    case "devicePairing.rotateToken":
    case "devicePairing.revokeToken":
      return executeDevicePairingCoreMutation(command, database);
    case "devicePairing.approveBootstrap": {
      const result = executeDevicePairingCoreMutation(command, database);
      if (result.result?.status === "approved" && result.replacedRoles.length > 0) {
        recordTokenReplacement({
          deviceId: result.result.device.deviceId,
          roles: result.replacedRoles,
        });
      }
      return result;
    }
    case "node.request":
    case "node.finalizeCleanup":
    case "node.approve":
    case "node.reject":
    case "node.recordConnection":
    case "node.recordDisconnection":
    case "node.recordHostStats":
    case "node.updateBins":
    case "node.updateSessionHost":
    case "node.rename":
      return executeDevicePairingNodeMutation(command, database);
    default:
      return executeDeviceBootstrapMutation(command, database, recordWorkerEnvironment);
  }
}

export function executeDevicePairingMutationInWorker(
  command: DevicePairingMutationCommand,
  database: OpenClawStateDatabase,
) {
  return runOpenClawStateWriteTransaction(
    () =>
      withDevicePairingStoreDatabase(database, () =>
        withDevicePairingMutationAdmission(() => {
          const before = readPairedDevicePairingRecordsFromDatabase(database.db);
          let tokensReplaced: DevicePairingCommitReceipt["tokensReplaced"];
          let workerEnvironment: DevicePairingCommitReceipt["workerEnvironment"];
          const result = execute(
            command,
            database,
            (facts) => {
              tokensReplaced = facts;
            },
            (facts) => {
              workerEnvironment = facts;
            },
          );
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
}
