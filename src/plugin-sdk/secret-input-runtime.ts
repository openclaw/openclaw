/**
 * Runtime SDK subpath for secret input normalization and configured secret resolution.
 */
import { coerceSecretRef, isLegacySecretRefWithoutProvider } from "../config/types.secrets.js";
import {
  resolveConfiguredSecretInputString as resolveConfiguredString,
  resolveConfiguredSecretInputWithFallback as resolveConfiguredWithFallback,
  resolveRequiredConfiguredSecretRefInputString as resolveRequiredConfiguredRef,
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

function configuredSdkInput(params: Parameters<typeof resolveConfiguredString>[0]): unknown {
  return isLegacySecretRefWithoutProvider(params.value)
    ? coerceSecretRef(params.value, params.config.secrets?.defaults)
    : params.value;
}

/** Keep the shipped unknown-valued SDK input contract outside canonical config readers. */
export function resolveConfiguredSecretInputString(
  params: Parameters<typeof resolveConfiguredString>[0],
): ReturnType<typeof resolveConfiguredString> {
  return resolveConfiguredString({ ...params, value: configuredSdkInput(params) });
}

export function resolveConfiguredSecretInputWithFallback(
  params: Parameters<typeof resolveConfiguredWithFallback>[0],
): ReturnType<typeof resolveConfiguredWithFallback> {
  return resolveConfiguredWithFallback({ ...params, value: configuredSdkInput(params) });
}

export function resolveRequiredConfiguredSecretRefInputString(
  params: Parameters<typeof resolveRequiredConfiguredRef>[0],
): ReturnType<typeof resolveRequiredConfiguredRef> {
  return resolveRequiredConfiguredRef({ ...params, value: configuredSdkInput(params) });
}

/** Reject use of a manifest-owned plugin capability whose startup secret is unavailable. */
export function assertPluginCapabilitySecretAvailable(ownerId: string): void {
  assertSecretOwnerAvailable("capability", ownerId);
}

/** Prepared-only capability credentials; no request-time file/exec/vault or ambient fallback. */
export { getPreparedPluginSecretInput } from "../secrets/prepared-plugin-input.js";
