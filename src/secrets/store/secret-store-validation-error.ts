import { isRedactedSecretValue } from "../../config/redact-sentinel.js";
import { ENV_SECRET_REF_ID_RE } from "../../config/types.secrets.js";
import { normalizeExactAllowedHost } from "../exact-hostname.js";

type SecretStoreValidationCode =
  | "SECRET_STORE_INVALID_NAME"
  | "SECRET_STORE_INVALID_ALLOWED_HOST"
  | "SECRET_STORE_VALUE_TOO_LARGE"
  | "SECRET_STORE_VALUE_REDACTED"
  | "SECRET_STORE_VALUE_CHANGED"
  | "SECRET_STORE_VALUE_EMPTY";

export class SecretStoreValidationError extends Error {
  constructor(
    readonly code: SecretStoreValidationCode,
    message: string,
  ) {
    super(message);
    this.name = "SecretStoreValidationError";
  }
}

export const SECRET_STORE_VALUE_MAX_BYTES = 64 * 1024;
export const SECRET_STORE_ALLOWED_HOSTS_MAX = 128;

export function assertSecretStoreValue(value: string, kind: "secret" | "env", name: string): void {
  if (isRedactedSecretValue(value)) {
    throw new SecretStoreValidationError(
      "SECRET_STORE_VALUE_REDACTED",
      `Secret store entry "${name}" contains a redaction placeholder. Supply a real value or leave the field unchanged. Run openclaw doctor --fix to repair a store-backed Gateway token.`,
    );
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > SECRET_STORE_VALUE_MAX_BYTES) {
    throw new SecretStoreValidationError(
      "SECRET_STORE_VALUE_TOO_LARGE",
      `Secret store value exceeds ${SECRET_STORE_VALUE_MAX_BYTES} UTF-8 bytes.`,
    );
  }
  // An empty credential is never meaningful and cannot be diagnosed later: `get`
  // refuses secret kinds and listings mask them, so a silently-empty secret (a
  // failed `op read |` pipe, for example) would surface only as a confusing 401.
  // Env entries may legitimately be empty.
  if (kind === "secret" && value.length === 0) {
    throw new SecretStoreValidationError(
      "SECRET_STORE_VALUE_EMPTY",
      "Secret store value is empty. Secret entries require a value; check the command that produced it.",
    );
  }
}

export function assertSecretStoreEnvName(name: string): void {
  if (!ENV_SECRET_REF_ID_RE.test(name)) {
    throw new SecretStoreValidationError(
      "SECRET_STORE_INVALID_NAME",
      `Secret store name must match ${String(ENV_SECRET_REF_ID_RE)}.`,
    );
  }
}

function normalizeSecretAllowedHost(raw: string): string {
  try {
    return normalizeExactAllowedHost(raw);
  } catch (error) {
    throw new SecretStoreValidationError(
      "SECRET_STORE_INVALID_ALLOWED_HOST",
      error instanceof Error ? error.message : `Allowed host "${raw}" is not a valid hostname.`,
    );
  }
}

export function normalizeSecretAllowedHosts(hosts: readonly string[]): string[] {
  if (hosts.length > SECRET_STORE_ALLOWED_HOSTS_MAX) {
    throw new SecretStoreValidationError(
      "SECRET_STORE_INVALID_ALLOWED_HOST",
      `A secret can allow at most ${SECRET_STORE_ALLOWED_HOSTS_MAX} hosts.`,
    );
  }
  return [...new Set(hosts.map(normalizeSecretAllowedHost))].toSorted();
}
