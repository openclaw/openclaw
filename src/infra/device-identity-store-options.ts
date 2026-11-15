import path from "node:path";
import { resolveClientCredentialStorePath } from "./client-credential-paths.js";
import { DeviceIdentityStorageError, normalizeIdentityKey } from "./device-identity-material.js";

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
  const databasePath = path.resolve(
    options.path ?? resolveClientCredentialStorePath(options.env ?? process.env),
  );
  if (
    path.basename(databasePath) !== "credentials.sqlite" ||
    path.basename(path.dirname(databasePath)) !== "client"
  ) {
    throw new DeviceIdentityStorageError(
      "Device identity path must be <client-root>/client/credentials.sqlite; pass env.OPENCLAW_STATE_DIR to select the client root.",
    );
  }
  return {
    databasePath,
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
