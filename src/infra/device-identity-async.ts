import { createSubsystemLogger } from "../logging/subsystem.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import {
  cacheProcessDeviceIdentity,
  getChatRequestIdentityKey,
  readProcessDeviceIdentity,
} from "./device-identity-process-cache.js";
import {
  assertNoPendingLegacyIdentity,
  resolveDeviceIdentityStore,
  type DeviceIdentity,
  type DeviceIdentityStoreOptions,
} from "./device-identity-store.js";

const log = createSubsystemLogger("gateway/chat");
let warnedUnavailableChatIdentity = false;

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

/** Read the admitted snapshot without creating SQLite state or joining the writer. */
export async function loadDeviceIdentityIfPresentAsync(
  options: DeviceIdentityStoreOptions = {},
): Promise<DeviceIdentity | null> {
  const { databasePath, identityKey } = resolveDeviceIdentityStore(options);
  const reply = await executeExistingOpenClawStateRead(
    { path: databasePath, env: options.env },
    { type: "deviceIdentity.read", input: { identityKey } },
  );
  const identity = reply?.identity ?? null;
  if (!identity) {
    assertNoPendingLegacyIdentity({ path: databasePath, identityKey });
  }
  return identity;
}
