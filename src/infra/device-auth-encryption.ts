/**
 * Resolves credential encryption options from the device identity.
 *
 * This is the bridge between the device identity system (root of trust)
 * and the credential encryption system.
 *
 * device.json is NOT encrypted (it's the root of trust — chicken-and-egg).
 * All other credential files (device-auth.json, auth-profiles.json) are encrypted
 * using keys derived from the device private key.
 */

import type {
  CredentialEncryptionMode,
  CredentialStoreOptions,
} from "../security/credential-store.js";
import { loadOrCreateDeviceIdentity } from "./device-identity.js";

let cachedOptions: CredentialStoreOptions | undefined;

/**
 * Resolve encryption options from the device identity.
 *
 * Returns undefined if credential encryption is disabled via
 * OPENCLAW_CREDENTIAL_ENCRYPTION=plaintext environment variable.
 */
export function resolveCredentialEncryptionOptions(
  env: NodeJS.ProcessEnv = process.env,
): CredentialStoreOptions | undefined {
  const modeOverride = env.OPENCLAW_CREDENTIAL_ENCRYPTION;
  if (modeOverride === "plaintext") {
    return undefined;
  }

  if (cachedOptions) {
    return cachedOptions;
  }

  try {
    const identity = loadOrCreateDeviceIdentity();
    const mode: CredentialEncryptionMode = "encrypted";
    cachedOptions = { privateKeyPem: identity.privateKeyPem, mode };
    return cachedOptions;
  } catch {
    // If device identity can't be loaded, fall back to no encryption.
    return undefined;
  }
}

/** Reset cached options (for testing). */
export function resetCredentialEncryptionOptionsCache(): void {
  cachedOptions = undefined;
}
