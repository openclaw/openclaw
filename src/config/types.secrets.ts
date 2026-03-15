export type SecretRefSource = "env" | "file" | "exec"; // pragma: allowlist secret

/**
 * Stable identifier for a secret in a configured source.
 * Examples:
 * - env source: provider "default", id "OPENAI_API_KEY"
 * - file source: provider "mounted-json", id "/providers/openai/apiKey"
 * - exec source: provider "vault", id "openai/api-key"
 */
export type SecretRef = {
  source: SecretRefSource;
  provider: string;
  id: string;
};

export type SecretInput = string | SecretRef;
export const DEFAULT_SECRET_PROVIDER_ALIAS = "default"; // pragma: allowlist secret
export const ENV_SECRET_REF_ID_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
const ENV_SECRET_TEMPLATE_RE = /^\$\{([A-Z][A-Z0-9_]{0,127})\}$/;
type SecretDefaults = {
  env?: string;
  file?: string;
  exec?: string;
};

export function isValidEnvSecretRefId(value: string): boolean {
  return ENV_SECRET_REF_ID_RE.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSecretRef(value: unknown): value is SecretRef {
  if (!isRecord(value)) {
    return false;
  }
  if (Object.keys(value).length !== 3) {
    return false;
  }
  return (
    (value.source === "env" || value.source === "file" || value.source === "exec") &&
    typeof value.provider === "string" &&
    value.provider.trim().length > 0 &&
    typeof value.id === "string" &&
    value.id.trim().length > 0
  );
}

function isLegacySecretRefWithoutProvider(
  value: unknown,
): value is { source: SecretRefSource; id: string } {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (value.source === "env" || value.source === "file" || value.source === "exec") &&
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    value.provider === undefined
  );
}

export function parseEnvTemplateSecretRef(
  value: unknown,
  provider = DEFAULT_SECRET_PROVIDER_ALIAS,
): SecretRef | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = ENV_SECRET_TEMPLATE_RE.exec(value.trim());
  if (!match) {
    return null;
  }
  return {
    source: "env",
    provider: provider.trim() || DEFAULT_SECRET_PROVIDER_ALIAS,
    id: match[1],
  };
}

export function coerceSecretRef(value: unknown, defaults?: SecretDefaults): SecretRef | null {
  if (isSecretRef(value)) {
    return value;
  }
  if (isLegacySecretRefWithoutProvider(value)) {
    const provider =
      value.source === "env"
        ? (defaults?.env ?? DEFAULT_SECRET_PROVIDER_ALIAS)
        : value.source === "file"
          ? (defaults?.file ?? DEFAULT_SECRET_PROVIDER_ALIAS)
          : (defaults?.exec ?? DEFAULT_SECRET_PROVIDER_ALIAS);
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

export function hasConfiguredSecretInput(value: unknown, defaults?: SecretDefaults): boolean {
  if (normalizeSecretInputString(value)) {
    return true;
  }
  return coerceSecretRef(value, defaults) !== null;
}

export function normalizeSecretInputString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function formatSecretRefLabel(ref: SecretRef): string {
  return `${ref.source}:${ref.provider}:${ref.id}`;
}

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
  throw new Error(
    `${params.path}: unresolved SecretRef "${formatSecretRefLabel(ref)}". Resolve this command against an active gateway runtime snapshot before reading it.`,
  );
}

export function normalizeResolvedSecretInputString(params: {
  value: unknown;
  refValue?: unknown;
  defaults?: SecretDefaults;
  path: string;
}): string | undefined {
  const normalized = normalizeSecretInputString(params.value);
  if (normalized) {
    return normalized;
  }
  assertSecretInputResolved(params);
  return undefined;
}

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
  const inlineRef = explicitRef ? null : coerceSecretRef(params.value, params.defaults);
  return {
    explicitRef,
    inlineRef,
    ref: explicitRef ?? inlineRef,
  };
}

export type EnvSecretProviderConfig = {
  source: "env";
  /** Optional env var allowlist (exact names). */
  allowlist?: string[];
};

export type FileSecretProviderMode = "singleValue" | "json"; // pragma: allowlist secret

export type FileSecretProviderConfig = {
  source: "file";
  path: string;
  mode?: FileSecretProviderMode;
  timeoutMs?: number;
  maxBytes?: number;
  trustedDirs?: string[];
  allowInsecurePath?: boolean;
  allowSymlinkPath?: boolean;
};

export type ExecSecretProviderConfig = {
  source: "exec";
  command: string;
  args?: string[];
  timeoutMs?: number;
  noOutputTimeoutMs?: number;
  maxOutputBytes?: number;
  jsonOnly?: boolean;
  env?: Record<string, string>;
  passEnv?: string[];
  trustedDirs?: string[];
  allowInsecurePath?: boolean;
  allowSymlinkCommand?: boolean;
};

export type SecretProviderConfig =
  | EnvSecretProviderConfig
  | FileSecretProviderConfig
  | ExecSecretProviderConfig;

export type SecretsConfig = {
  providers?: Record<string, SecretProviderConfig>;
  defaults?: {
    env?: string;
    file?: string;
    exec?: string;
  };
  resolution?: {
    maxProviderConcurrency?: number;
    maxRefsPerProvider?: number;
    maxBatchBytes?: number;
  };
};
