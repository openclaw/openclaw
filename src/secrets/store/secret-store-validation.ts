// Shared name/value/host validation for the team secret store.
import { isRedactedSecretValue } from "../../config/redact-sentinel.js";
import { ENV_SECRET_REF_ID_RE } from "../../config/types.secrets.js";
import { normalizeExactAllowedHost } from "../exact-hostname.js";
import { classifyHiddenGitHubStoreName } from "./secret-store-hidden-github.js";
import {
  SECRET_STORE_ALLOWED_HOSTS_MAX,
  SecretStoreValidationError,
} from "./secret-store-validation-error.js";
import { assertSecretStoreValueLength } from "./secret-store-value.js";
import type { SecretStoreKind } from "./secret-store.types.js";

export type { SecretStoreKind, SecretStoreScope } from "./secret-store.types.js";

export function assertSecretStoreEnvName(name: string): void {
  if (!ENV_SECRET_REF_ID_RE.test(name)) {
    throw new SecretStoreValidationError(
      "SECRET_STORE_INVALID_NAME",
      `Secret store name must match ${String(ENV_SECRET_REF_ID_RE)}.`,
    );
  }
}

export function assertSecretStoreMutationName(name: string): void {
  if (!ENV_SECRET_REF_ID_RE.test(name) && classifyHiddenGitHubStoreName(name) !== "setup") {
    throw new SecretStoreValidationError(
      "SECRET_STORE_INVALID_NAME",
      `Secret store name must match ${String(ENV_SECRET_REF_ID_RE)} or github-setup-<32 lowercase hex characters>.`,
    );
  }
}

export function assertSecretStoreValue(value: string, kind: SecretStoreKind, name: string): void {
  if (isRedactedSecretValue(value)) {
    throw new SecretStoreValidationError(
      "SECRET_STORE_VALUE_REDACTED",
      `Secret store entry "${name}" contains a redaction placeholder. Supply a real value or leave the field unchanged. Run openclaw doctor --fix to repair a store-backed Gateway token.`,
    );
  }
  assertSecretStoreValueLength(value, kind);
}

export function assertSecretStoreWriteShape(
  value: string,
  kind: SecretStoreKind,
  name: string,
  allowedHosts: readonly string[] | undefined,
): void {
  assertSecretStoreValue(value, kind, name);
  if (kind === "env" && allowedHosts !== undefined) {
    throw new SecretStoreValidationError(
      "SECRET_STORE_INVALID_ALLOWED_HOST",
      "Allowed hosts apply only to secret entries.",
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

export function parseSecretAllowedHosts(raw: string | null | undefined): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.every((host) => typeof host === "string")
      ? normalizeSecretAllowedHosts(parsed)
      : [];
  } catch {
    // Corrupt policy is never interpreted permissively: an empty list fails closed.
    return [];
  }
}
