/** Shared SecretRef grammar and validation helpers for config, schema, SDK, and gateway parity. */
import { isRecord } from "@openclaw/normalization-core/record-coerce";

export type SecretRefSource = "env" | "file" | "exec" | "store"; // pragma: allowlist secret

/**
 * Stable identifier for a secret in a configured source.
 * Examples:
 * - env source: provider "default", id "OPENAI_API_KEY"
 * - file source: provider "mounted-json", id "/providers/openai/apiKey"
 * - exec source: provider "vault", id "openai/api-key"
 * - store source: provider "default", id "OPENAI_API_KEY"
 */
export type SecretRef = {
  source: SecretRefSource;
  provider: string;
  id: string;
};

export type SecretInput = string | SecretRef;

/** Provider alias used when a SecretRef omits a source-specific provider. */
export const DEFAULT_SECRET_PROVIDER_ALIAS = "default"; // pragma: allowlist secret
export const ENV_SECRET_REF_ID_RE = /^[A-Z][A-Z0-9_]{0,127}$/;

export function isValidEnvSecretRefId(value: string): boolean {
  return ENV_SECRET_REF_ID_RE.test(value);
}

export function isSecretRef(value: unknown): value is SecretRef {
  if (!isRecord(value)) {
    return false;
  }
  if (Object.keys(value).length !== 3) {
    return false;
  }
  return (
    (value.source === "env" ||
      value.source === "file" ||
      value.source === "exec" ||
      value.source === "store") &&
    typeof value.provider === "string" &&
    value.provider.trim().length > 0 &&
    typeof value.id === "string" &&
    value.id.trim().length > 0
  );
}

/**
 * Runtime secret-reference grammar shared by config parsing, plugin SDK schemas,
 * gateway parity checks, and resolver planning.
 */

const FILE_SECRET_REF_SEGMENT_PATTERN = /^(?:[^~]|~0|~1)*$/;
/** Shared alias grammar for env/file/exec/store secret provider names. */
export const SECRET_PROVIDER_ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const EXEC_SECRET_REF_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$/;

/** Canonical id for file secret providers that expose exactly one value. */
export const SINGLE_VALUE_FILE_REF_ID = "value";

type ExecSecretRefIdValidationReason = "pattern" | "traversal-segment";

type ExecSecretRefIdValidationResult =
  | { ok: true }
  | {
      ok: false;
      reason: ExecSecretRefIdValidationReason;
    };

type SecretRefDefaultsCarrier = {
  secrets?: {
    /** Explicit per-source provider aliases selected by the operator. */
    defaults?: {
      env?: string;
      file?: string;
      exec?: string;
      store?: string;
    };
    /** Provider declarations used only when callers ask to prefer the first matching source. */
    providers?: Record<string, { source?: string }>;
  };
};

export function secretRefKey(ref: SecretRef): string {
  return `${ref.source}:${ref.provider}:${ref.id}`;
}

export function resolveDefaultSecretProviderAlias(
  config: SecretRefDefaultsCarrier,
  source: SecretRefSource,
  options?: { preferFirstProviderForSource?: boolean },
): string {
  const configured = config.secrets?.defaults?.[source];
  if (configured?.trim()) {
    return configured.trim();
  }

  if (options?.preferFirstProviderForSource) {
    const providers = config.secrets?.providers;
    if (providers) {
      // Preserve config insertion order: interactive setup uses this as a
      // deterministic fallback only when no explicit source default exists.
      for (const [providerName, provider] of Object.entries(providers)) {
        if (provider?.source === source) {
          return providerName;
        }
      }
    }
  }

  return DEFAULT_SECRET_PROVIDER_ALIAS;
}

export function createGatewayEnvSecretRef(
  config: SecretRefDefaultsCarrier,
  envVarName: string,
): SecretRef {
  return {
    source: "env",
    provider: resolveDefaultSecretProviderAlias(config, "env", {
      preferFirstProviderForSource: true,
    }),
    id: envVarName,
  };
}

/** Whether a source-specific built-in provider owns this selected default alias. */
export function isBuiltInDefaultSecretProviderRef(
  config: SecretRefDefaultsCarrier,
  ref: SecretRef,
): boolean {
  const configuredSource = config.secrets?.providers?.[ref.provider]?.source;
  return (
    configuredSource !== ref.source &&
    (ref.source === "env" || ref.source === "store") &&
    ref.provider === resolveDefaultSecretProviderAlias(config, ref.source)
  );
}

/** Returns the configured provider source when a SecretRef selects an impossible pairing. */
export function resolveSecretRefProviderSourceMismatch(
  config: SecretRefDefaultsCarrier,
  ref: SecretRef,
): string | null {
  const configuredSource = config.secrets?.providers?.[ref.provider]?.source;
  if (
    !configuredSource ||
    configuredSource === ref.source ||
    isBuiltInDefaultSecretProviderRef(config, ref)
  ) {
    return null;
  }
  return configuredSource;
}

/** Validates file secret ref ids against the shared JSON-pointer-style contract. */
export function isValidFileSecretRefId(value: string): boolean {
  if (value === SINGLE_VALUE_FILE_REF_ID) {
    return true;
  }
  if (!value.startsWith("/")) {
    return false;
  }
  // File refs mirror JSON Pointer segment escaping; keep this in parity with gateway/schema
  // patterns so config, plugin SDK, and remote gateway validation accept the same ids.
  return value
    .slice(1)
    .split("/")
    .every((segment) => FILE_SECRET_REF_SEGMENT_PATTERN.test(segment));
}

export function isValidSecretProviderAlias(value: string): boolean {
  return SECRET_PROVIDER_ALIAS_PATTERN.test(value);
}

export function validateExecSecretRefId(value: string): ExecSecretRefIdValidationResult {
  if (!EXEC_SECRET_REF_ID_PATTERN.test(value)) {
    return { ok: false, reason: "pattern" };
  }
  // The JSON schema uses a negative lookahead for traversal. Runtime validation keeps the same
  // rule explicit so UI/doctor flows can explain the safer failure class.
  for (const segment of value.split("/")) {
    if (segment === "." || segment === "..") {
      return { ok: false, reason: "traversal-segment" };
    }
  }
  return { ok: true };
}

export function isValidExecSecretRefId(value: string): boolean {
  return validateExecSecretRefId(value).ok;
}

export function isValidSecretRef(ref: SecretRef): boolean {
  if (!isSecretRef(ref)) {
    return false;
  }
  if (!isValidSecretProviderAlias(ref.provider)) {
    return false;
  }
  if (ref.source === "env") {
    return isValidEnvSecretRefId(ref.id);
  }
  if (ref.source === "file") {
    return isValidFileSecretRefId(ref.id);
  }
  if (ref.source === "store") {
    return isValidEnvSecretRefId(ref.id);
  }
  return isValidExecSecretRefId(ref.id);
}

export function formatExecSecretRefIdValidationMessage(): string {
  return [
    "Exec secret reference id must match /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$/",
    'and must not include "." or ".." path segments',
    '(example: "vault/openai/api-key" or "aws/secret#json_key").',
  ].join(" ");
}

export type ProviderRefGroup = {
  source: SecretRefSource;
  providerName: string;
  refs: SecretRef[];
};

export function normalizeAndGroupSecretRefs(refs: SecretRef[]): ProviderRefGroup[] {
  if (refs.length === 0) {
    return [];
  }
  const uniqueRefs = new Map<string, SecretRef>();
  for (const ref of refs) {
    const id = ref.id.trim();
    if (!id) {
      throw new Error("Secret reference id is empty.");
    }
    if (!isValidSecretProviderAlias(ref.provider)) {
      throw new Error(
        `Secret reference provider must match /^[a-z][a-z0-9_-]{0,63}$/ (ref: ${ref.source}:${ref.provider}:${id}).`,
      );
    }
    if (ref.source === "env" && !isValidEnvSecretRefId(id)) {
      throw new Error(
        `Env secret reference id must match /^[A-Z][A-Z0-9_]{0,127}$/ (ref: ${ref.source}:${ref.provider}:${id}).`,
      );
    }
    if (ref.source === "file" && !isValidFileSecretRefId(id)) {
      throw new Error(
        `File secret reference id must be an absolute JSON pointer or "value" (ref: ${ref.source}:${ref.provider}:${id}).`,
      );
    }
    if (ref.source === "store" && !isValidEnvSecretRefId(id)) {
      throw new Error(
        `Store secret reference id must match /^[A-Z][A-Z0-9_]{0,127}$/ (ref: ${ref.source}:${ref.provider}:${id}).`,
      );
    }
    if (ref.source === "exec" && !isValidExecSecretRefId(id)) {
      throw new Error(
        `${formatExecSecretRefIdValidationMessage()} (ref: ${ref.source}:${ref.provider}:${id}).`,
      );
    }
    uniqueRefs.set(secretRefKey(ref), { ...ref, id });
  }

  const grouped = new Map<string, ProviderRefGroup>();
  for (const ref of uniqueRefs.values()) {
    // Provider calls are batched by source/provider so exec providers receive one request for
    // many ids and file providers parse once per payload.
    const key = `${ref.source}:${ref.provider}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.refs.push(ref);
      continue;
    }
    grouped.set(key, { source: ref.source, providerName: ref.provider, refs: [ref] });
  }
  return [...grouped.values()];
}
