import { holdStateDatabaseWriteTransaction } from "../test-utils/state-database-contention.js";
import { runClientCredentialOperation } from "./client-credential-store.js";
import { createDeviceAuthEntry, deviceAuthEntryFromRow } from "./device-auth-store.kernel.js";

type Lookup = { deviceId: string; role: string; env?: NodeJS.ProcessEnv };
type Seed = Lookup & { token: string; scopes?: string[]; updatedAtMs?: number };

export function readDeviceAuthTokenForTest(params: Lookup) {
  const result = runClientCredentialOperation(params.env ?? process.env, {
    kind: "token.read",
    key: { device_id: params.deviceId, role: params.role },
  });
  return result.kind === "token" && result.token ? deviceAuthEntryFromRow(result.token) : null;
}

function seed(params: Seed & { gatewayScope?: string }) {
  const entry = createDeviceAuthEntry(params);
  runClientCredentialOperation(params.env ?? process.env, {
    kind: "token.replace",
    key: {
      device_id: params.deviceId,
      role: entry.role,
      ...(params.gatewayScope === undefined ? {} : { gateway_scope: params.gatewayScope }),
    },
    token: {
      device_id: params.deviceId,
      role: entry.role,
      token: entry.token,
      scopes_json: JSON.stringify(entry.scopes),
      updated_at_ms: entry.updatedAtMs,
    },
  });
  return entry;
}
export function seedDeviceAuthToken(params: Seed) {
  return seed(params);
}
export function seedOriginDeviceToken(params: Seed & { gatewayScope: string }) {
  return seed(params);
}

/** Hold a synthetic native writer while the host proves its asynchronous admission. */
export async function holdDeviceAuthWriterForTest(databasePath: string) {
  const holder = holdStateDatabaseWriteTransaction(databasePath, 10_000);
  await holder.ready;
  return async () => {
    holder.release();
    await holder.joined;
  };
}
