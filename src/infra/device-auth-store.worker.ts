import type { DatabaseSync } from "node:sqlite";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type { WorkerOperationContext } from "../state/worker-operation-registry.js";
import * as deviceAuth from "./device-auth-store.kernel.js";
import { requestSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";

function read<Input>(
  operation: (db: DatabaseSync, input: Input) => deviceAuth.DeviceAuthTokenObservation,
) {
  return (input: Input & { readOnly: boolean }, { open, stateOptions }: WorkerOperationContext) =>
    input.readOnly
      ? (withExistingOpenClawStateDatabaseReadOnly(
          ({ db }) => operation(db, input),
          stateOptions(),
        ) ?? { entry: null, expectedToken: null })
      : operation(open().db, input);
}

function write<Input, Output>(operation: (db: DatabaseSync, input: Input) => Output) {
  return (input: Input, { open, stateOptions }: WorkerOperationContext): Output =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        const result = operation(db, input);
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        return result;
      },
      { database: open(), ...stateOptions() },
    );
}

export const deviceAuthWorkerOperations = {
  "deviceAuth.prepare": (_input: undefined) => undefined,
  "deviceAuth.read": read(deviceAuth.readDeviceAuthTokenObservationFromDatabase),
  "deviceAuth.readOrigin": read(deviceAuth.readOriginDeviceTokenObservationFromDatabase),
  "deviceAuth.list": (input: { deviceId: string }, { open }: WorkerOperationContext) =>
    deviceAuth.readDeviceAuthTokensFromDatabase(open().db, input),
  "deviceAuth.store": write(deviceAuth.storeDeviceAuthTokenInDatabase),
  "deviceAuth.storeOrigin": write(deviceAuth.storeOriginDeviceTokenInDatabase),
  "deviceAuth.clear": write(deviceAuth.clearDeviceAuthTokenFromDatabase),
  "deviceAuth.clearOrigin": write(deviceAuth.clearOriginDeviceTokenInDatabase),
};
