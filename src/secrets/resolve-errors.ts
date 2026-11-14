/** Typed errors for SecretRef provider and ref-level resolution failures. */
import type { SecretRef, SecretRefSource } from "../config/types.secrets.js";

const SECRET_REF_FAILURE_REASONS = {
  SECRET_REF_NOT_FOUND: "secret reference was not found",
  SECRET_REF_POLICY_DENIED: "secret provider policy denied resolution",
  SECRET_REF_INVALID: undefined,
  SECRET_REF_REDACTED_VALUE: "resolved secret value is a redaction placeholder",
  SECRET_REF_PROVIDER_ERROR: "secret provider failed",
  SECRET_REF_PROVIDER_CONTRACT: "secret provider response violated its contract",
} as const;

const SECRET_PROVIDER_FAILURE_REASONS = {
  SECRET_PROVIDER_PATH_SECURITY_UNVERIFIABLE: "secret provider failed",
  SECRET_PROVIDER_INVALID: undefined,
  SECRET_PROVIDER_NOT_CONFIGURED: undefined,
  SECRET_PROVIDER_UNAVAILABLE: "secret provider failed",
} as const;

type SecretRefResolutionCode = keyof typeof SECRET_REF_FAILURE_REASONS;
type SecretProviderResolutionCode = keyof typeof SECRET_PROVIDER_FAILURE_REASONS;
type SecretResolutionFailureReason = NonNullable<
  | (typeof SECRET_REF_FAILURE_REASONS)[SecretRefResolutionCode]
  | (typeof SECRET_PROVIDER_FAILURE_REASONS)[SecretProviderResolutionCode]
>;

/** Error for failures that affect an entire configured secret provider. */
class SecretProviderResolutionError extends Error {
  readonly scope = "provider" as const;
  readonly code: SecretProviderResolutionCode;
  readonly source: SecretRefSource;
  readonly provider: string;

  constructor(params: {
    code: SecretProviderResolutionCode;
    source: SecretRefSource;
    provider: string;
    message: string;
    cause?: unknown;
  }) {
    super(params.message, params.cause !== undefined ? { cause: params.cause } : undefined);
    this.name = "SecretProviderResolutionError";
    this.code = params.code;
    this.source = params.source;
    this.provider = params.provider;
  }
}

/** Error for failures limited to one SecretRef id under a provider. */
class SecretRefResolutionError extends Error {
  readonly scope = "ref" as const;
  readonly code: SecretRefResolutionCode;
  readonly source: SecretRefSource;
  readonly provider: string;
  readonly refId: string;

  constructor(params: {
    code: SecretRefResolutionCode;
    source: SecretRefSource;
    provider: string;
    refId: string;
    message: string;
    cause?: unknown;
  }) {
    super(params.message, params.cause !== undefined ? { cause: params.cause } : undefined);
    this.name = "SecretRefResolutionError";
    this.code = params.code;
    this.source = params.source;
    this.provider = params.provider;
    this.refId = params.refId;
  }
}

/** Type guard for provider-scoped secret resolution failures. */
export function isProviderScopedSecretResolutionError(
  value: unknown,
): value is SecretProviderResolutionError {
  return value instanceof SecretProviderResolutionError;
}

export function isSecretResolutionError(
  value: unknown,
): value is SecretProviderResolutionError | SecretRefResolutionError {
  return (
    value instanceof SecretProviderResolutionError || value instanceof SecretRefResolutionError
  );
}

/** Redacted reason suitable for warnings and status output. */
export function describeSecretResolutionError(
  value: unknown,
): SecretResolutionFailureReason | undefined {
  if (value instanceof SecretProviderResolutionError) {
    return SECRET_PROVIDER_FAILURE_REASONS[value.code];
  }
  return value instanceof SecretRefResolutionError
    ? SECRET_REF_FAILURE_REASONS[value.code]
    : undefined;
}

/** Sanitized provider detail suitable for operator-facing diagnostics. */
export function describeSecretResolutionOperatorDiagnostic(value: unknown): string | undefined {
  if (value instanceof SecretRefResolutionError && value.code === "SECRET_REF_REDACTED_VALUE") {
    return `Secret reference "${value.source}:${value.provider}:${value.refId}" resolves to a redaction placeholder`;
  }
  if (
    value instanceof SecretProviderResolutionError &&
    value.code === "SECRET_PROVIDER_PATH_SECURITY_UNVERIFIABLE"
  ) {
    return "Windows path security could not be verified";
  }
  return undefined;
}

/** Sanitized recovery action suitable for operator-facing diagnostics. */
export function describeSecretResolutionOperatorRecovery(value: unknown): string | undefined {
  if (value instanceof SecretRefResolutionError && value.code === "SECRET_REF_REDACTED_VALUE") {
    return "Run openclaw doctor --fix to repair a store-backed Gateway token; supply a real credential for other secrets, then restart the Gateway and reconnect or re-pair clients";
  }
  if (
    !(value instanceof SecretProviderResolutionError) ||
    value.code !== "SECRET_PROVIDER_PATH_SECURITY_UNVERIFIABLE"
  ) {
    return undefined;
  }
  return value.source === "exec"
    ? "Restore Windows path security verification, or use an existing provider command whose owner and ACLs OpenClaw can verify"
    : "Restore Windows path security verification, or use an existing secret file whose owner and ACLs OpenClaw can verify";
}

export function providerResolutionError(
  params: Omit<ConstructorParameters<typeof SecretProviderResolutionError>[0], "code"> & {
    code?: SecretProviderResolutionCode;
  },
): SecretProviderResolutionError {
  return new SecretProviderResolutionError({
    ...params,
    code: params.code ?? "SECRET_PROVIDER_UNAVAILABLE",
  });
}

export function refResolutionError(
  params: ConstructorParameters<typeof SecretRefResolutionError>[0],
): SecretRefResolutionError {
  return new SecretRefResolutionError(params);
}

/** Returns whether one SecretRef failed because its configured value is absent. */
export function isMissingSecretRefResolutionError(params: {
  ref: SecretRef;
  error: unknown;
}): boolean {
  const refId = params.ref.id.trim();
  // Canonical refs already own their provider identity. Config defaults only fill an omitted
  // provider during coercion; resolution never rewrites an explicit provider such as "default".
  return (
    params.error instanceof SecretRefResolutionError &&
    params.error.code === "SECRET_REF_NOT_FOUND" &&
    params.error.source === params.ref.source &&
    params.error.provider === params.ref.provider &&
    params.error.refId === refId
  );
}
