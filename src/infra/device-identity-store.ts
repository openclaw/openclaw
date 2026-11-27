// Client private identities belong to the local credential owner, independently of shared state.
import { runClientCredentialOperation } from "./client-credential-store.js";
import {
  identityFromCredentialResult,
  storedDeviceIdentityToRow,
  type StoredDeviceIdentity,
} from "./device-identity-material.js";
import {
  resolveDeviceIdentityEnvironment,
  resolveDeviceIdentityStore,
  type DeviceIdentityStoreOptions,
} from "./device-identity-store-options.js";

export {
  DeviceIdentityStorageError,
  generateStoredDeviceIdentity,
  validateStoredDeviceIdentity,
  type DeviceIdentity,
  type StoredDeviceIdentity,
} from "./device-identity-material.js";

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

/**
 * Inspection cannot settle import claims or initialize local credential state, and reads
 * under a shared lock, so an open credential write transaction neither blocks it nor is
 * blocked by it.
 */
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
      { inspect: true },
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
