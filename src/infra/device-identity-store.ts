// Client private identities belong to the local credential owner, independently of shared state.
import path from "node:path";
import {
  resolveClientCredentialStorePath,
  runClientCredentialOperation,
  type ClientCredentialResult,
} from "./client-credential-store.js";
import {
  normalizeIdentityKey,
  storedDeviceIdentityToRow,
  type StoredDeviceIdentity,
} from "./device-identity-material.js";

export {
  DeviceIdentityStorageError,
  generateStoredDeviceIdentity,
  validateStoredDeviceIdentity,
  type DeviceIdentity,
  type StoredDeviceIdentity,
} from "./device-identity-material.js";

export type DeviceIdentityStoreOptions = {
  env?: NodeJS.ProcessEnv;
  path?: string;
  identityKey?: string;
};

/** Resolve once before awaiting work so another caller's environment cannot change the root. */
export function resolveDeviceIdentityStore(options: DeviceIdentityStoreOptions = {}): {
  databasePath: string;
  identityKey: string;
} {
  return {
    databasePath: path.resolve(
      options.path ?? resolveClientCredentialStorePath(options.env ?? process.env),
    ),
    identityKey: normalizeIdentityKey(options.identityKey),
  };
}

export function resolveDeviceIdentityEnvironment(
  options: DeviceIdentityStoreOptions,
): NodeJS.ProcessEnv {
  const { databasePath } = resolveDeviceIdentityStore(options);
  return {
    ...(options.env ?? process.env),
    OPENCLAW_STATE_DIR: path.dirname(path.dirname(databasePath)),
  };
}

export function identityFromCredentialResult(
  result: ClientCredentialResult,
): StoredDeviceIdentity | null {
  if (result.kind !== "identity") {
    throw new Error("Client credential owner returned an unexpected identity result.");
  }
  const row = result.identity;
  return row
    ? {
        deviceId: row.device_id,
        publicKeyPem: row.public_key_pem,
        privateKeyPem: row.private_key_pem,
        createdAtMs: row.created_at_ms,
      }
    : null;
}

/** Synchronous access is reserved for offline Doctor/CLI one-shots. Runtime callers use the worker. */
export function readStoredDeviceIdentity(
  options: DeviceIdentityStoreOptions = {},
): StoredDeviceIdentity | null {
  const { identityKey } = resolveDeviceIdentityStore(options);
  return identityFromCredentialResult(
    runClientCredentialOperation(resolveDeviceIdentityEnvironment(options), {
      kind: "identity.read",
      identity_key: identityKey,
    }),
  );
}

/** Inspection cannot settle import claims or initialize local credential state. */
export function readStoredDeviceIdentityReadOnly(
  options: DeviceIdentityStoreOptions = {},
): StoredDeviceIdentity | null {
  const { identityKey } = resolveDeviceIdentityStore(options);
  return identityFromCredentialResult(
    runClientCredentialOperation(
      resolveDeviceIdentityEnvironment(options),
      {
        kind: "identity.read",
        identity_key: identityKey,
      },
      { readOnly: true },
    ),
  );
}

export function insertStoredDeviceIdentityIfAbsent(
  candidate: StoredDeviceIdentity,
  options: DeviceIdentityStoreOptions = {},
): StoredDeviceIdentity {
  const { identityKey } = resolveDeviceIdentityStore(options);
  const stored = identityFromCredentialResult(
    runClientCredentialOperation(resolveDeviceIdentityEnvironment(options), {
      kind: "identity.create",
      identity: storedDeviceIdentityToRow(identityKey, candidate),
    }),
  );
  if (!stored) {
    throw new Error(`Client credential owner did not persist identity "${identityKey}".`);
  }
  return stored;
}

/** Doctor preserves valid key bytes and only replaces irreparable identities. */
export function repairInvalidStoredDeviceIdentity(
  candidate: StoredDeviceIdentity,
  options: DeviceIdentityStoreOptions = {},
): { identity: StoredDeviceIdentity; repaired: boolean; rotated: boolean } {
  const { identityKey } = resolveDeviceIdentityStore(options);
  const result = runClientCredentialOperation(resolveDeviceIdentityEnvironment(options), {
    kind: "identity.repair",
    identity: storedDeviceIdentityToRow(identityKey, candidate),
  });
  if (result.kind !== "identityRepair") {
    throw new Error("Client credential owner returned an unexpected repair result.");
  }
  return {
    identity: {
      deviceId: result.identity.device_id,
      publicKeyPem: result.identity.public_key_pem,
      privateKeyPem: result.identity.private_key_pem,
      createdAtMs: result.identity.created_at_ms,
    },
    repaired: result.repaired,
    rotated: result.rotated,
  };
}
