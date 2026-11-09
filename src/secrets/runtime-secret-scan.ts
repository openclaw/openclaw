/** Scans config-like values for SecretRefs and credential-looking fields. */
import { isLegacySecretRefWithoutProvider, parseSecretRef } from "../config/types.secrets.js";
import type { SecretDefaults } from "./runtime-shared.js";

/** Field names treated as credential-bearing even before a value is converted to SecretRef. */
const CREDENTIAL_FIELD_NAMES = new Set(["apikey", "key", "token", "secret", "password"]);

function hasRecursiveSecretValue(
  value: unknown,
  defaults: SecretDefaults | undefined,
  seen: WeakSet<object>,
  includeCredentialFields = false,
): boolean {
  if (isLegacySecretRefWithoutProvider(value) || parseSecretRef(value, defaults)) {
    return true;
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  if (seen.has(value)) {
    // Config-like objects can be caller-constructed; avoid cycles while scanning recursively.
    return false;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) =>
      hasRecursiveSecretValue(entry, defaults, seen, includeCredentialFields),
    );
  }
  return Object.entries(value as Record<string, unknown>).some(
    ([key, entry]) =>
      (includeCredentialFields &&
        CREDENTIAL_FIELD_NAMES.has(key.toLowerCase()) &&
        entry != null &&
        entry !== "") ||
      hasRecursiveSecretValue(entry, defaults, seen, includeCredentialFields),
  );
}

/** Returns whether a value tree contains anything coercible to a SecretRef. */
export function hasSecretRefCandidate(
  value: unknown,
  defaults: SecretDefaults | undefined,
): boolean {
  return hasRecursiveSecretValue(value, defaults, new WeakSet());
}

/**
 * Returns whether a value tree contains SecretRefs or non-empty credential-looking fields.
 * Used before runtime fast-paths so enabled web tools do not skip secret-aware preparation.
 */
export function hasCredentialBearingObjectValue(
  value: unknown,
  defaults: SecretDefaults | undefined,
): boolean {
  return hasRecursiveSecretValue(value, defaults, new WeakSet(), true);
}
