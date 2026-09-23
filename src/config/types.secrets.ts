// Defines secret reference and resolution configuration types.
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { z } from "zod";
import {
  DEFAULT_SECRET_PROVIDER_ALIAS,
  ENV_SECRET_REF_ID_RE,
  isSecretRef,
  type SecretRef,
  type SecretRefSource,
} from "../secrets/ref-contract.js";
import type { SecretProviderSchema, SecretsConfigSchema } from "./zod-schema.core.js";
export {
  DEFAULT_SECRET_PROVIDER_ALIAS,
  ENV_SECRET_REF_ID_RE,
  isSecretRef,
  isValidEnvSecretRefId,
  type SecretInput,
  type SecretRef,
  type SecretRefSource,
} from "../secrets/ref-contract.js";
/** Legacy env SecretRef marker retained for config migration/read compatibility. */
export const LEGACY_SECRETREF_ENV_MARKER_PREFIX = "secretref-env:"; // pragma: allowlist secret
/** Older env SecretRef marker retained for migration/read compatibility. */
export const LEGACY_DOUBLE_UNDERSCORE_ENV_MARKER_PREFIX = "__env__:"; // pragma: allowlist secret
const ENV_SECRET_TEMPLATE_RE = /^\$\{([A-Z][A-Z0-9_]{0,127})\}$/;
const ENV_SECRET_SHORTHAND_RE = /^\$([A-Z][A-Z0-9_]{0,127})$/;
/** Secret string read mode: throw on unresolved refs or inspect without resolving. */
export type SecretInputStringResolutionMode = "strict" | "inspect";
/** Result of reading a secret input without necessarily materializing the secret value. */
export type SecretInputStringResolution =
  | { status: "available"; value: string; ref: null }
  | { status: "configured_unavailable"; value: undefined; ref: SecretRef }
  | { status: "missing"; value: undefined; ref: null };
type SecretDefaults = {
  /** Default provider alias for env SecretRefs. */
  env?: string;
  /** Default provider alias for file SecretRefs. */
  file?: string;
  /** Default provider alias for exec SecretRefs. */
  exec?: string;
  /** Default provider alias for shared-store SecretRefs. */
  store?: string;
};

function isLegacySecretRefWithoutProvider(
  value: unknown,
): value is { source: SecretRefSource; id: string } {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (value.source === "env" ||
      value.source === "file" ||
      value.source === "exec" ||
      value.source === "store") &&
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    value.provider === undefined
  );
}

/** Parse `$NAME` and `${NAME}` env-secret shorthand strings into env SecretRefs. */
export function parseEnvTemplateSecretRef(
  value: unknown,
  provider = DEFAULT_SECRET_PROVIDER_ALIAS,
): SecretRef | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  const match = ENV_SECRET_TEMPLATE_RE.exec(trimmed) ?? ENV_SECRET_SHORTHAND_RE.exec(trimmed);
  if (!match) {
    return null;
  }
  return {
    source: "env",
    provider: provider.trim() || DEFAULT_SECRET_PROVIDER_ALIAS,
    id: expectDefined(match[1], "types.secrets regex capture 1"),
  };
}

/** Detect retired env SecretRef marker strings for migration and explicit rejection. */
export function isLegacySecretRefEnvMarker(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  return (
    trimmed.startsWith(LEGACY_SECRETREF_ENV_MARKER_PREFIX) ||
    trimmed.startsWith(LEGACY_DOUBLE_UNDERSCORE_ENV_MARKER_PREFIX)
  );
}

/** Parse legacy env SecretRef marker strings for config migration. */
export function parseLegacySecretRefEnvMarker(
  value: unknown,
  provider = DEFAULT_SECRET_PROVIDER_ALIAS,
): SecretRef | null {
  if (!isLegacySecretRefEnvMarker(value)) {
    return null;
  }
  const trimmed = value.trim();
  const prefix = trimmed.startsWith(LEGACY_SECRETREF_ENV_MARKER_PREFIX)
    ? LEGACY_SECRETREF_ENV_MARKER_PREFIX
    : trimmed.startsWith(LEGACY_DOUBLE_UNDERSCORE_ENV_MARKER_PREFIX)
      ? LEGACY_DOUBLE_UNDERSCORE_ENV_MARKER_PREFIX
      : undefined;
  if (!prefix) {
    return null;
  }
  const id = trimmed.slice(prefix.length);
  if (!ENV_SECRET_REF_ID_RE.test(id)) {
    return null;
  }
  return {
    source: "env",
    provider: provider.trim() || DEFAULT_SECRET_PROVIDER_ALIAS,
    id,
  };
}

/** Coerce canonical and env-shorthand secret inputs into a SecretRef.
 * Retired string markers are parsed only by doctor migration above. */
export function coerceSecretRef(value: unknown, defaults?: SecretDefaults): SecretRef | null {
  if (isSecretRef(value)) {
    return value;
  }
  if (isLegacySecretRefWithoutProvider(value)) {
    const provider = defaults?.[value.source] ?? DEFAULT_SECRET_PROVIDER_ALIAS;
    return {
      source: value.source,
      provider,
      id: value.id,
    };
  }
  const envTemplate = parseEnvTemplateSecretRef(value, defaults?.env);
  if (envTemplate) {
    return envTemplate;
  }
  return null;
}

/** Return whether a value contains either a literal secret string or resolvable SecretRef shape. */
export function hasConfiguredSecretInput(value: unknown, defaults?: SecretDefaults): boolean {
  if (normalizeSecretInputString(value)) {
    return true;
  }
  return coerceSecretRef(value, defaults) !== null;
}

/** Trim a literal secret input string while leaving non-string inputs unresolved. */
export function normalizeSecretInputString(value: unknown): string | undefined {
  return normalizeOptionalString(value);
}

function formatSecretRefLabel(ref: SecretRef): string {
  return `${ref.source}:${ref.provider}:${ref.id}`;
}

/** Error thrown when strict secret reads encounter a configured but unresolved SecretRef. */
export class UnresolvedSecretInputError extends Error {
  readonly path: string;
  readonly ref: SecretRef;

  constructor(params: { path: string; ref: SecretRef }) {
    super(
      `${params.path}: unresolved SecretRef "${formatSecretRefLabel(params.ref)}". Resolve this command against an active gateway runtime snapshot before reading it.`,
    );
    this.name = "UnresolvedSecretInputError";
    this.path = params.path;
    this.ref = params.ref;
  }
}

/** Narrow errors from strict secret read sites without parsing user-facing messages. */
export function isUnresolvedSecretInputError(value: unknown): value is UnresolvedSecretInputError {
  return value instanceof UnresolvedSecretInputError;
}

function createUnresolvedSecretInputError(params: { path: string; ref: SecretRef }): Error {
  return new UnresolvedSecretInputError(params);
}

/** Throw when a secret field still contains an unresolved SecretRef at a read site. */
export function assertSecretInputResolved(params: {
  value: unknown;
  refValue?: unknown;
  defaults?: SecretDefaults;
  path: string;
}): void {
  const { ref } = resolveSecretInputRef({
    value: params.value,
    refValue: params.refValue,
    defaults: params.defaults,
  });
  if (!ref) {
    return;
  }
  throw createUnresolvedSecretInputError({ path: params.path, ref });
}

/** Resolve a secret field to either a literal value, a configured-unavailable ref, or missing. */
export function resolveSecretInputString(params: {
  value: unknown;
  refValue?: unknown;
  defaults?: SecretDefaults;
  path: string;
  mode?: SecretInputStringResolutionMode;
}): SecretInputStringResolution {
  const { explicitRef, ref } = resolveSecretInputRef({
    value: params.value,
    refValue: params.refValue,
    defaults: params.defaults,
  });
  const normalized = normalizeSecretInputString(params.value);
  if (normalized && !explicitRef) {
    return {
      status: "available",
      value: normalized,
      ref: null,
    };
  }
  if (!ref) {
    return {
      status: "missing",
      value: undefined,
      ref: null,
    };
  }
  if ((params.mode ?? "strict") === "strict") {
    throw createUnresolvedSecretInputError({ path: params.path, ref });
  }
  return {
    status: "configured_unavailable",
    value: undefined,
    ref,
  };
}

/** Return a strict literal secret value, throwing if the field still points at a SecretRef. */
export function normalizeResolvedSecretInputString(params: {
  value: unknown;
  refValue?: unknown;
  defaults?: SecretDefaults;
  path: string;
}): string | undefined {
  const resolved = resolveSecretInputString({
    ...params,
    mode: "strict",
  });
  if (resolved.status === "available") {
    return resolved.value;
  }
  return undefined;
}

/** Resolve explicit `refValue` before inline secret references embedded in `value`. */
export function resolveSecretInputRef(params: {
  value: unknown;
  refValue?: unknown;
  defaults?: SecretDefaults;
}): {
  explicitRef: SecretRef | null;
  inlineRef: SecretRef | null;
  ref: SecretRef | null;
} {
  const explicitRef = coerceSecretRef(params.refValue, params.defaults);
  // Explicit ref fields take precedence so a literal fallback can stay beside a configured ref.
  const inlineRef = explicitRef ? null : coerceSecretRef(params.value, params.defaults);
  return {
    explicitRef,
    inlineRef,
    ref: explicitRef ?? inlineRef,
  };
}

export type SecretProviderConfig = z.input<typeof SecretProviderSchema>;

export type EnvSecretProviderConfig = Extract<SecretProviderConfig, { source: "env" }>;

export type FileSecretProviderConfig = Extract<SecretProviderConfig, { source: "file" }>;

export type FileSecretProviderMode = NonNullable<FileSecretProviderConfig["mode"]>;

export type ExecSecretProviderConfig = Extract<SecretProviderConfig, { source: "exec" }>;

export type ManualExecSecretProviderConfig = Extract<ExecSecretProviderConfig, { command: string }>;

export type PluginIntegrationSecretProviderConfig = Exclude<
  ExecSecretProviderConfig,
  ManualExecSecretProviderConfig
>;

export type StoreSecretProviderConfig = Extract<SecretProviderConfig, { source: "store" }>;

export type SecretsConfig = NonNullable<z.input<typeof SecretsConfigSchema>>;
