// ---------------------------------------------------------------------------
// Secret reference types
// ---------------------------------------------------------------------------

export type SecretRefSource = "env" | "file" | "exec" | "kms";

export type SecretRef = {
  source: SecretRefSource;
  provider: string;
  id: string;
};

/** A secret value that is either an inline string or a structured reference. */
export type SecretInput = string | SecretRef;

export const DEFAULT_SECRET_PROVIDER_ALIAS = "default";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Runtime type guard for SecretRef shaped values. */
export function isSecretRef(value: unknown): value is SecretRef {
  if (!isRecord(value)) {
    return false;
  }
  const { source, id } = value;
  if (typeof id !== "string" || !id.trim()) {
    return false;
  }
  return source === "env" || source === "file" || source === "exec" || source === "kms";
}

// ---------------------------------------------------------------------------
// Secret provider configuration (per-source)
// ---------------------------------------------------------------------------

export type EnvSecretProviderConfig = {
  source: "env";
  allowlist?: string[];
};

export type FileSecretProviderConfig = {
  source: "file";
  path: string;
  mode?: "singleValue" | "json";
  timeoutMs?: number;
  maxBytes?: number;
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

export type KmsSecretProviderConfig = {
  source: "kms";
  /** KMS project/workspace id (overrides secrets.kms.projectId). */
  projectId?: string;
  /** KMS environment slug (overrides secrets.kms.environment). */
  environment?: string;
  /** KMS secret folder path (overrides secrets.kms.secretPath). */
  secretPath?: string;
};

export type SecretProviderConfig =
  | EnvSecretProviderConfig
  | FileSecretProviderConfig
  | ExecSecretProviderConfig
  | KmsSecretProviderConfig;

/** Shape accepted as `defaults` parameter by `coerceSecretRef`. */
export type SecretRefDefaultsCarrier =
  | SecretDefaults
  | { secrets?: { defaults?: SecretDefaults } }
  | undefined;

/** Normalize the polymorphic defaults carrier to a flat SecretDefaults. */
function resolveDefaults(carrier?: SecretRefDefaultsCarrier): SecretDefaults | undefined {
  if (!carrier) {
    return undefined;
  }
  if ("secrets" in carrier) {
    return (carrier as { secrets?: { defaults?: SecretDefaults } }).secrets?.defaults;
  }
  return carrier as SecretDefaults;
}

/**
 * Coerce a value into a SecretRef if it matches the shape { source, id }.
 * Returns null when the value is not ref-shaped.
 */
export function coerceSecretRef(
  value: unknown,
  defaults?: SecretRefDefaultsCarrier,
): SecretRef | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const obj = value as Record<string, unknown>;
  const source = obj.source;
  if (source !== "env" && source !== "file" && source !== "exec" && source !== "kms") {
    return null;
  }
  const id = typeof obj.id === "string" ? obj.id : undefined;
  if (!id) {
    return null;
  }
  const d = resolveDefaults(defaults);
  const provider =
    typeof obj.provider === "string" && obj.provider.trim()
      ? obj.provider
      : ((source === "env"
          ? d?.env
          : source === "file"
            ? d?.file
            : source === "exec"
              ? d?.exec
              : d?.kms) ?? DEFAULT_SECRET_PROVIDER_ALIAS);
  return { source, provider, id };
}

// ---------------------------------------------------------------------------
// KMS configuration types
// ---------------------------------------------------------------------------

export type KmsMachineIdentityConfig = {
  /** Machine identity client id for universal auth login. */
  clientId?: string;
  /** Machine identity client secret for universal auth login. */
  clientSecret?: string;
};

export type KmsSecretsConfig = {
  /** KMS base URL (defaults to https://kms.hanzo.ai). */
  siteUrl?: string;
  /** Tenant org slug metadata (optional, for policy/audit context). */
  orgSlug?: string;
  /** Project/workspace id. */
  projectId?: string;
  /** Project/workspace slug. */
  projectSlug?: string;
  /** Environment slug (for example: dev, staging, prod). */
  environment?: string;
  /** Secret folder path (defaults to /). */
  secretPath?: string;
  /** Optional pre-issued KMS access token. */
  accessToken?: string;
  /** Machine identity credentials for universal auth. */
  machineIdentity?: KmsMachineIdentityConfig;
  /** Cache TTL for resolved secret values. Default: 15000 ms. */
  cacheTtlMs?: number;
  /** Network timeout for KMS API calls. Default: 10000 ms. */
  requestTimeoutMs?: number;
};

export type SecretDefaults = {
  env?: string;
  file?: string;
  exec?: string;
  kms?: string;
};

export type SecretResolutionConfig = {
  maxProviderConcurrency?: number;
  maxRefsPerProvider?: number;
  maxBatchBytes?: number;
};

export type SecretsConfig = {
  /** Secret backend mode. "kms" enables KMS reference resolution. */
  backend?: "local" | "kms";
  kms?: KmsSecretsConfig;
  /** Named secret providers keyed by alias (e.g. "default"). */
  providers?: Record<string, SecretProviderConfig>;
  /** Per-source default provider aliases. */
  defaults?: SecretDefaults;
  /** Resolution limits for batch/concurrency control. */
  resolution?: SecretResolutionConfig;
};
