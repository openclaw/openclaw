import { createSubsystemLogger } from "../logging/subsystem.js";
import { runClientCredentialOperationAsync } from "./client-credential-async.js";
import {
  generateStoredDeviceIdentity,
  storedDeviceIdentityToRow,
} from "./device-identity-material.js";
import {
  cacheProcessDeviceIdentity,
  getChatRequestIdentityKey,
  readProcessDeviceIdentity,
} from "./device-identity-process-cache.js";
import {
  identityFromCredentialResult,
  resolveDeviceIdentityEnvironment,
  resolveDeviceIdentityStore,
  type DeviceIdentity,
  type DeviceIdentityStoreOptions,
} from "./device-identity-store.js";

const log = createSubsystemLogger("gateway/chat");
let warnedUnavailableChatIdentity = false;

/** Resolve private signing material without opening the selected Gateway database. */
export async function loadOrCreateDeviceIdentityAsync(
  options: DeviceIdentityStoreOptions = {},
): Promise<DeviceIdentity> {
  const { identityKey } = resolveDeviceIdentityStore(options);
  const env = resolveDeviceIdentityEnvironment(options);
  const stored = identityFromCredentialResult(
    await runClientCredentialOperationAsync(env, {
      kind: "identity.create",
      identity: storedDeviceIdentityToRow(identityKey, generateStoredDeviceIdentity()),
    }),
  );
  if (!stored) {
    throw new Error(`Client credential owner did not persist identity "${identityKey}".`);
  }
  return {
    deviceId: stored.deviceId,
    publicKeyPem: stored.publicKeyPem,
    privateKeyPem: stored.privateKeyPem,
  };
}

/** Keep the existing process-lifetime identity cache without opening SQLite on a warm hit. */
export async function loadOrCreateProcessDeviceIdentityAsync(
  options: DeviceIdentityStoreOptions = {},
): Promise<DeviceIdentity> {
  const { databasePath, identityKey } = resolveDeviceIdentityStore(options);
  const cacheKey = `${databasePath}\0${identityKey}`;
  const cached = readProcessDeviceIdentity(cacheKey);
  if (cached) {
    return cached;
  }
  const identity = await loadOrCreateDeviceIdentityAsync({
    ...options,
    path: databasePath,
    identityKey,
  });
  return cacheProcessDeviceIdentity(cacheKey, identity);
}

/** Chat admission consumes an existing identity without creating or replacing one. */
export async function loadChatRequestIdentityKeyAsync(
  options: DeviceIdentityStoreOptions = {},
): Promise<Buffer | null> {
  const { databasePath, identityKey } = resolveDeviceIdentityStore(options);
  const cacheKey = `${databasePath}\0${identityKey}`;
  try {
    const identity =
      readProcessDeviceIdentity(cacheKey) ??
      (await loadDeviceIdentityIfPresentAsync({ ...options, path: databasePath, identityKey }));
    if (identity) {
      return getChatRequestIdentityKey(cacheProcessDeviceIdentity(cacheKey, identity));
    }
  } catch {
    // Optional retry fingerprints must not turn identity read failures into a chat outage.
  }
  if (!warnedUnavailableChatIdentity) {
    warnedUnavailableChatIdentity = true;
    log.warn(
      `Gateway device identity "${identityKey}" is missing or unreadable; chat.send will continue without a keyed request fingerprint.`,
    );
  }
  return null;
}

/** Existing-only reads never create a local store or a signing identity. */
export async function loadDeviceIdentityIfPresentAsync(
  options: DeviceIdentityStoreOptions = {},
): Promise<DeviceIdentity | null> {
  const { identityKey } = resolveDeviceIdentityStore(options);
  const stored = identityFromCredentialResult(
    await runClientCredentialOperationAsync(resolveDeviceIdentityEnvironment(options), {
      kind: "identity.read",
      identity_key: identityKey,
    }),
  );
  return stored
    ? {
        deviceId: stored.deviceId,
        publicKeyPem: stored.publicKeyPem,
        privateKeyPem: stored.privateKeyPem,
      }
    : null;
}
