import type { WorkerOperationHandlers } from "../state/worker-operation-registry.js";
import {
  readStoredDeviceIdentityReadOnlyInDatabase,
  type DeviceIdentity,
} from "./device-identity-store.js";
import type { EngineConnection } from "./sql-connection.js";

export const deviceIdentityReadOperations = {
  "deviceIdentity.read": (input: { identityKey: string }, db) => {
    const stored = readStoredDeviceIdentityReadOnlyInDatabase(db, input.identityKey);
    const identity: DeviceIdentity | null = stored
      ? {
          deviceId: stored.deviceId,
          publicKeyPem: stored.publicKeyPem,
          privateKeyPem: stored.privateKeyPem,
        }
      : null;
    return { type: "deviceIdentity.read" as const, identity };
  },
} satisfies WorkerOperationHandlers<EngineConnection>;
