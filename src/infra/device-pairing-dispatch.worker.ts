import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import type { WorkerOperationContext } from "../state/worker-operation-registry.js";
import { prepareDevicePairingBinding } from "./device-pairing-binding.js";
import { withDevicePairingMutationAdmission } from "./device-pairing-mutation.worker.js";
import type { DevicePairingCommitReceipt } from "./device-pairing-read.types.js";
import {
  readPairedDevicePairingSnapshotFromDatabase,
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
  recordNodeApproval: (facts: NonNullable<DevicePairingCommitReceipt["nodeApproval"]>) => void;
  recordRetiredNodeToken: (
    facts: NonNullable<DevicePairingCommitReceipt["retiredNodeToken"]>,
  ) => void;
};

export function devicePairingMutation<Input, Result>(
  operation: (input: Input, context: DevicePairingMutationContext) => Result,
  {
    publishPairing = true,
    pairedDeviceId,
  }: { publishPairing?: boolean; pairedDeviceId?: (input: Input) => string } = {},
) {
  return (input: Input, { open }: WorkerOperationContext): Result => {
    const database = open();
    return runOpenClawStateWriteTransaction(
      () =>
        withDevicePairingMutationAdmission(() => {
          const snapshot = publishPairing
            ? readPairedDevicePairingSnapshotFromDatabase(
                database.db,
                pairedDeviceId?.(input).trim(),
              )
            : undefined;
          const before = snapshot?.pairedByDeviceId;
          const after = before ? structuredClone(before) : undefined;
          const revision = { value: snapshot?.revision ?? "0" };
          return withDevicePairingStoreDatabase(
            database,
            () => {
              let tokensReplaced: DevicePairingCommitReceipt["tokensReplaced"];
              let workerEnvironment: DevicePairingCommitReceipt["workerEnvironment"];
              let nodeApproval: DevicePairingCommitReceipt["nodeApproval"];
              let retiredNodeToken: DevicePairingCommitReceipt["retiredNodeToken"];
              const result = operation(input, {
                database,
                recordTokenReplacement: (facts) => {
                  tokensReplaced = facts;
                },
                recordWorkerEnvironment: (facts) => {
                  workerEnvironment = facts;
                },
                recordRetiredNodeToken: (facts) => {
                  retiredNodeToken = facts;
                },
                recordNodeApproval: (facts) => {
                  nodeApproval = facts;
                },
              });
              if (!before || !after) {
                return result;
              }
              const changed: DevicePairingCommitReceipt["changed"] = [];
              for (const deviceId of new Set([...Object.keys(before), ...Object.keys(after)])) {
                if (JSON.stringify(before[deviceId]) !== JSON.stringify(after[deviceId])) {
                  changed.push(prepareDevicePairingBinding(deviceId, after[deviceId] ?? null));
                }
              }
              deferSqliteWorkerCommitReceipt(database.db, {
                kind: "devicePairing",
                beforeRevision: snapshot!.revision,
                revision: revision.value,
                changed,
                ...(tokensReplaced ? { tokensReplaced } : {}),
                ...(retiredNodeToken ? { retiredNodeToken } : {}),
                ...(workerEnvironment ? { workerEnvironment } : {}),
                ...(nodeApproval ? { nodeApproval } : {}),
              } satisfies DevicePairingCommitReceipt);
              return result;
            },
            after,
            revision,
          );
        }),
      { database, env: getSqliteWorkerStateContext().environment },
    );
  };
}
