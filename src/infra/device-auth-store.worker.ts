import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import type {
  WorkerOperationContext,
  WorkerWriteOperationContext,
} from "../state/worker-operation-registry.js";
import * as deviceAuth from "./device-auth-store.kernel.js";
import type { EngineConnection } from "./sql-connection.js";

function read<Input>(
  operation: (db: EngineConnection, input: Input) => deviceAuth.DeviceAuthTokenObservation,
) {
  return (input: Input & { readOnly: boolean }, { open, stateOptions }: WorkerOperationContext) =>
    input.readOnly
      ? (withExistingOpenClawStateDatabaseReadOnly(
          ({ db }) => operation(db, input),
          stateOptions(),
        ) ?? { entry: null, expectedToken: null })
      : operation(open().db, input);
}

function write<Input, Output>(operation: (db: EngineConnection, input: Input) => Output) {
  return (input: Input, { writeAdmitted }: WorkerWriteOperationContext): Output =>
    writeAdmitted(({ db }) => operation(db, input));
}

export const deviceAuthWorkerOperations = {
  "deviceAuth.prepare": (_input: undefined): void => undefined,
  "deviceAuth.read": read(deviceAuth.readDeviceAuthTokenObservationFromDatabase),
  "deviceAuth.readOrigin": read(deviceAuth.readOriginDeviceTokenObservationFromDatabase),
  "deviceAuth.list": (input: { deviceId: string }, { open }: WorkerOperationContext) =>
    deviceAuth.readDeviceAuthTokensFromDatabase(open().db, input),
  "deviceAuth.store": write(deviceAuth.storeDeviceAuthTokenInDatabase),
  "deviceAuth.storeOrigin": write(deviceAuth.storeOriginDeviceTokenInDatabase),
  "deviceAuth.clear": write(deviceAuth.clearDeviceAuthTokenFromDatabase),
  "deviceAuth.clearOrigin": write(deviceAuth.clearOriginDeviceTokenInDatabase),
};
