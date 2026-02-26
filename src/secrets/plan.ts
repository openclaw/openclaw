import type { SecretProviderConfig, SecretRef } from "../config/types.secrets.js";
import { SecretProviderSchema } from "../config/zod-schema.core.js";

export type SecretsPlanTargetType =
  | "models.providers.apiKey"
  | "skills.entries.apiKey"
  | "channels.googlechat.serviceAccount";

export type SecretsPlanTarget = {
  type: SecretsPlanTargetType;
  /**
   * Dot path in openclaw.json for operator readability.
   * Example: "models.providers.openai.apiKey"
   */
  path: string;
  /**
   * Canonical path segments used for safe mutation.
   * Example: ["models", "providers", "openai", "apiKey"]
   */
  pathSegments?: string[];
  ref: SecretRef;
  /**
   * For provider targets, used to scrub auth-profile/static residues.
   */
  providerId?: string;
  /**
   * For googlechat account-scoped targets.
   */
  accountId?: string;
};

export type SecretsApplyPlan = {
  version: 1;
  protocolVersion: 1;
  generatedAt: string;
  generatedBy: "openclaw secrets configure" | "manual";
  providerUpserts?: Record<string, SecretProviderConfig>;
  providerDeletes?: string[];
  targets: SecretsPlanTarget[];
  options?: {
    scrubEnv?: boolean;
    scrubAuthProfilesForProviderTargets?: boolean;
    scrubLegacyAuthJson?: boolean;
  };
};

const PROVIDER_ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function isSecretsPlanTargetType(value: unknown): value is SecretsPlanTargetType {
  return (
    value === "models.providers.apiKey" ||
    value === "skills.entries.apiKey" ||
    value === "channels.googlechat.serviceAccount"
  );
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSecretProviderConfigShape(value: unknown): value is SecretProviderConfig {
  return SecretProviderSchema.safeParse(value).success;
}

function parseDotPath(pathname: string): string[] {
  return pathname
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function hasForbiddenPathSegment(segments: string[]): boolean {
  return segments.some((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment));
}

function hasMatchingPathShape(
  candidate: Pick<SecretsPlanTarget, "type" | "providerId" | "accountId">,
  segments: string[],
): boolean {
  if (candidate.type === "models.providers.apiKey") {
    if (
      segments.length !== 4 ||
      segments[0] !== "models" ||
      segments[1] !== "providers" ||
      segments[3] !== "apiKey"
    ) {
      return false;
    }
    return (
      candidate.providerId === undefined ||
      candidate.providerId.trim().length === 0 ||
      candidate.providerId === segments[2]
    );
  }
  if (candidate.type === "skills.entries.apiKey") {
    return (
      segments.length === 4 &&
      segments[0] === "skills" &&
      segments[1] === "entries" &&
      segments[3] === "apiKey"
    );
  }
  if (
    segments.length === 3 &&
    segments[0] === "channels" &&
    segments[1] === "googlechat" &&
    segments[2] === "serviceAccount"
  ) {
    return candidate.accountId === undefined || candidate.accountId.trim().length === 0;
  }
  if (
    segments.length === 5 &&
    segments[0] === "channels" &&
    segments[1] === "googlechat" &&
    segments[2] === "accounts" &&
    segments[4] === "serviceAccount"
  ) {
    return (
      candidate.accountId === undefined ||
      candidate.accountId.trim().length === 0 ||
      candidate.accountId === segments[3]
    );
  }
  return false;
}

export function resolveValidatedTargetPathSegments(candidate: {
  type?: SecretsPlanTargetType;
  path?: string;
  pathSegments?: string[];
  providerId?: string;
  accountId?: string;
}): string[] | null {
  if (!isSecretsPlanTargetType(candidate.type)) {
    return null;
  }
  const path = typeof candidate.path === "string" ? candidate.path.trim() : "";
  if (!path) {
    return null;
  }
  const segments =
    Array.isArray(candidate.pathSegments) && candidate.pathSegments.length > 0
      ? candidate.pathSegments.map((segment) => String(segment).trim()).filter(Boolean)
      : parseDotPath(path);
  if (
    segments.length === 0 ||
    hasForbiddenPathSegment(segments) ||
    path !== segments.join(".") ||
    !hasMatchingPathShape(
      {
        type: candidate.type,
        providerId: candidate.providerId,
        accountId: candidate.accountId,
      },
      segments,
    )
  ) {
    return null;
  }
  return segments;
}

export function isSecretsApplyPlan(value: unknown): value is SecretsApplyPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const typed = value as Partial<SecretsApplyPlan>;
  if (typed.version !== 1 || typed.protocolVersion !== 1 || !Array.isArray(typed.targets)) {
    return false;
  }
  for (const target of typed.targets) {
    if (!target || typeof target !== "object") {
      return false;
    }
    const candidate = target as Partial<SecretsPlanTarget>;
    const ref = candidate.ref as Partial<SecretRef> | undefined;
    if (
      (candidate.type !== "models.providers.apiKey" &&
        candidate.type !== "skills.entries.apiKey" &&
        candidate.type !== "channels.googlechat.serviceAccount") ||
      typeof candidate.path !== "string" ||
      !candidate.path.trim() ||
      (candidate.pathSegments !== undefined && !Array.isArray(candidate.pathSegments)) ||
      !resolveValidatedTargetPathSegments({
        type: candidate.type,
        path: candidate.path,
        pathSegments: candidate.pathSegments,
        providerId: candidate.providerId,
        accountId: candidate.accountId,
      }) ||
      !ref ||
      typeof ref !== "object" ||
      (ref.source !== "env" && ref.source !== "file" && ref.source !== "exec") ||
      typeof ref.provider !== "string" ||
      ref.provider.trim().length === 0 ||
      typeof ref.id !== "string" ||
      ref.id.trim().length === 0
    ) {
      return false;
    }
  }
  if (typed.providerUpserts !== undefined) {
    if (!isObjectRecord(typed.providerUpserts)) {
      return false;
    }
    for (const [providerAlias, providerValue] of Object.entries(typed.providerUpserts)) {
      if (!PROVIDER_ALIAS_PATTERN.test(providerAlias)) {
        return false;
      }
      if (!isSecretProviderConfigShape(providerValue)) {
        return false;
      }
    }
  }
  if (typed.providerDeletes !== undefined) {
    if (
      !Array.isArray(typed.providerDeletes) ||
      typed.providerDeletes.some(
        (providerAlias) =>
          typeof providerAlias !== "string" || !PROVIDER_ALIAS_PATTERN.test(providerAlias),
      )
    ) {
      return false;
    }
  }
  return true;
}

export function normalizeSecretsPlanOptions(
  options: SecretsApplyPlan["options"] | undefined,
): Required<NonNullable<SecretsApplyPlan["options"]>> {
  return {
    scrubEnv: options?.scrubEnv ?? true,
    scrubAuthProfilesForProviderTargets: options?.scrubAuthProfilesForProviderTargets ?? true,
    scrubLegacyAuthJson: options?.scrubLegacyAuthJson ?? true,
  };
}
