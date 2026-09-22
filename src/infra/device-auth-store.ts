// Persists device authorization records for paired nodes.
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { DeviceAuthEntry } from "../shared/device-auth.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../state/openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  clearDeviceAuthTokenFromDatabase,
  clearOriginDeviceTokenInDatabase,
  createDeviceAuthEntry,
  type DeviceAuthTokenObservation,
  readDeviceAuthTokenObservationFromDatabase,
  readDeviceAuthTokensFromDatabase,
  readOriginDeviceTokenObservationFromDatabase,
  storeDeviceAuthTokenInDatabase,
  storeOriginDeviceTokenInDatabase,
} from "./device-auth-store.kernel.js";

export { clearDeviceAuthTokenFromDatabase } from "./device-auth-store.kernel.js";

// The Gateway lock makes state-directory contents process-stable. Cache both
// outcomes to keep reconnects free of freshness polling; Doctor invalidates
// the entry after its exclusive legacy import removes the retired file.
const legacyPresenceCache = new Map<string, boolean>();

function assertNoLegacyDeviceAuth(env: NodeJS.ProcessEnv | undefined): void {
  const stateDir = resolveStateDir(env);
  let hasLegacy = legacyPresenceCache.get(stateDir);
  if (hasLegacy === undefined) {
    hasLegacy = fs.existsSync(path.join(stateDir, "identity", "device-auth.json"));
    legacyPresenceCache.set(stateDir, hasLegacy);
  }
  if (hasLegacy) {
    throw new Error(
      "Legacy device auth requires migration; stop the Gateway and run `openclaw doctor --fix`.",
    );
  }
}

/** Forget one process-local legacy-state probe after Doctor removes the source. */
export function resetLegacyDeviceAuthPresenceCache(env: NodeJS.ProcessEnv): void {
  legacyPresenceCache.delete(resolveStateDir(env));
}

type DeviceAuthLookup = { deviceId: string; role: string; env?: NodeJS.ProcessEnv };
type OriginDeviceAuthLookup = DeviceAuthLookup & { gatewayScope: string };
type DeviceAuthRead = {
  onSnapshot?: (observation: DeviceAuthTokenObservation) => void;
};
type DeviceAuthWrite = DeviceAuthLookup & {
  token: string;
  scopes?: string[];
  expectedToken?: string | null;
};
type DeviceAuthClear = DeviceAuthLookup & {
  expectedToken?: string;
  observedToken?: string;
};

export function loadDeviceAuthToken(
  params: DeviceAuthLookup & DeviceAuthRead,
): DeviceAuthEntry | null {
  assertNoLegacyDeviceAuth(params.env);
  const { db } = openOpenClawStateDatabase({ env: params.env });
  const observation = readDeviceAuthTokenObservationFromDatabase(db, params);
  params.onSnapshot?.(observation);
  return observation.entry;
}

export function loadDeviceAuthTokenReadOnly(
  params: DeviceAuthLookup & DeviceAuthRead,
): DeviceAuthEntry | null {
  assertNoLegacyDeviceAuth(params.env);
  const observation = withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
    ({ db }) => readDeviceAuthTokenObservationFromDatabase(db, params),
    { env: params.env },
  ) ?? { entry: null, expectedToken: null };
  params.onSnapshot?.(observation);
  return observation.entry;
}

export function loadDeviceAuthTokens(params: {
  deviceId: string;
  env?: NodeJS.ProcessEnv;
}): DeviceAuthEntry[] {
  assertNoLegacyDeviceAuth(params.env);
  const { db } = openOpenClawStateDatabase({ env: params.env });
  return readDeviceAuthTokensFromDatabase(db, params);
}

export function storeDeviceAuthToken(params: DeviceAuthWrite): DeviceAuthEntry | null {
  assertNoLegacyDeviceAuth(params.env);
  const entry = createDeviceAuthEntry(params);
  return runOpenClawStateWriteTransaction(
    ({ db }) =>
      storeDeviceAuthTokenInDatabase(db, {
        deviceId: params.deviceId,
        ...entry,
        expectedToken: params.expectedToken,
      }),
    { env: params.env },
  );
}

export function clearDeviceAuthToken(params: DeviceAuthClear): boolean {
  assertNoLegacyDeviceAuth(params.env);
  return runOpenClawStateWriteTransaction(
    ({ db }) => clearDeviceAuthTokenFromDatabase(db, params),
    { env: params.env },
  );
}

export function loadOriginDeviceToken(
  params: OriginDeviceAuthLookup & DeviceAuthRead,
): DeviceAuthEntry | null {
  assertNoLegacyDeviceAuth(params.env);
  const { db } = openOpenClawStateDatabase({ env: params.env });
  const observation = readOriginDeviceTokenObservationFromDatabase(db, params);
  params.onSnapshot?.(observation);
  return observation.entry;
}

export function loadOriginDeviceTokenReadOnly(
  params: OriginDeviceAuthLookup & DeviceAuthRead,
): DeviceAuthEntry | null {
  assertNoLegacyDeviceAuth(params.env);
  const observation = withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
    ({ db }) => readOriginDeviceTokenObservationFromDatabase(db, params),
    { env: params.env },
  ) ?? { entry: null, expectedToken: null };
  params.onSnapshot?.(observation);
  return observation.entry;
}

export function storeOriginDeviceToken(
  params: DeviceAuthWrite & { gatewayScope: string },
): DeviceAuthEntry | null {
  assertNoLegacyDeviceAuth(params.env);
  const entry = createDeviceAuthEntry(params);
  return runOpenClawStateWriteTransaction(
    ({ db }) =>
      storeOriginDeviceTokenInDatabase(db, {
        gatewayScope: params.gatewayScope,
        deviceId: params.deviceId,
        ...entry,
        expectedToken: params.expectedToken,
      }),
    { env: params.env },
  );
}

export function clearOriginDeviceToken(
  params: DeviceAuthClear & { gatewayScope: string },
): boolean {
  assertNoLegacyDeviceAuth(params.env);
  return runOpenClawStateWriteTransaction(
    ({ db }) => clearOriginDeviceTokenInDatabase(db, params),
    { env: params.env },
  );
}
