import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import {
  cacheProcessDeviceIdentity,
  readProcessDeviceIdentity,
} from "./device-identity-process-cache.js";
import {
  resolveDeviceIdentityStore,
  type DeviceIdentity,
  type DeviceIdentityStoreOptions,
} from "./device-identity-store.js";
import { assertNoPendingLegacyIdentity } from "./device-identity.js";

/** Bootstrap through the identity owner before the shared actor opens a missing database. */
export async function loadOrCreateDeviceIdentityAsync(
  options: DeviceIdentityStoreOptions = {},
): Promise<DeviceIdentity> {
  const { databasePath, identityKey } = resolveDeviceIdentityStore(options);
  const context = captureOpenClawStateWorkerContext({ ...options, path: databasePath });
  return await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "deviceIdentity.load", input: { identityKey } }),
    { preparation: { type: "deviceIdentity", identityKey } },
  );
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

/** Read the captured identity on the shared worker without creating SQLite state. */
export async function loadDeviceIdentityIfPresentAsync(
  options: DeviceIdentityStoreOptions = {},
): Promise<DeviceIdentity | null> {
  const { databasePath, identityKey } = resolveDeviceIdentityStore(options);
  const context = captureOpenClawStateWorkerContext({ ...options, path: databasePath });
  const identity = await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "deviceIdentity.read", input: { identityKey } }),
    { existingOnly: true },
  );
  if (identity !== undefined) {
    return identity;
  }
  assertNoPendingLegacyIdentity({ path: databasePath, identityKey });
  return null;
}
