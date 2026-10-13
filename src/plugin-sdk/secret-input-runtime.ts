/**
 * Runtime SDK subpath for secret input normalization and configured secret resolution.
 */
import { coerceSecretRef, isLegacySecretRefWithoutProvider } from "../config/types.secrets.js";
import {
  resolveCanonicalConfiguredSecretInputString,
  resolveCanonicalConfiguredSecretInputWithFallback,
  resolveCanonicalRequiredConfiguredSecretRefInputString,
} from "../gateway/resolve-configured-secret-input-string.js";
import { assertSecretOwnerAvailable } from "../secrets/runtime-degraded-state.js";

export {
  coerceSecretRef,
  hasConfiguredSecretInput,
  isSecretRef,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
  resolveSecretInputString,
  type SecretInput,
  type SecretInputStringResolution,
  type SecretInputStringResolutionMode,
} from "../config/types.secrets.js";

function configuredSdkInput(
  params: Parameters<typeof resolveCanonicalConfiguredSecretInputString>[0],
): unknown {
  return isLegacySecretRefWithoutProvider(params.value)
    ? coerceSecretRef(params.value, params.config.secrets?.defaults)
    : params.value;
}

/** Keep the shipped unknown-valued SDK input contract outside canonical config readers. */
export function resolveConfiguredSecretInputString(
  params: Parameters<typeof resolveCanonicalConfiguredSecretInputString>[0],
): ReturnType<typeof resolveCanonicalConfiguredSecretInputString> {
  return resolveCanonicalConfiguredSecretInputString({
    ...params,
    value: configuredSdkInput(params),
  });
}

export function resolveConfiguredSecretInputWithFallback(
  params: Parameters<typeof resolveCanonicalConfiguredSecretInputWithFallback>[0],
): ReturnType<typeof resolveCanonicalConfiguredSecretInputWithFallback> {
  return resolveCanonicalConfiguredSecretInputWithFallback({
    ...params,
    value: configuredSdkInput(params),
  });
}

export function resolveRequiredConfiguredSecretRefInputString(
  params: Parameters<typeof resolveCanonicalRequiredConfiguredSecretRefInputString>[0],
): ReturnType<typeof resolveCanonicalRequiredConfiguredSecretRefInputString> {
  return resolveCanonicalRequiredConfiguredSecretRefInputString({
    ...params,
    value: configuredSdkInput(params),
  });
}

/** Reject use of a manifest-owned plugin capability whose startup secret is unavailable. */
export function assertPluginCapabilitySecretAvailable(ownerId: string): void {
  assertSecretOwnerAvailable("capability", ownerId);
}

/** Prepared-only capability credentials; no request-time file/exec/vault or ambient fallback. */
export { getPreparedPluginSecretInput } from "../secrets/prepared-plugin-input.js";
