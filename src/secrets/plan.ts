import type { SecretProviderConfig, SecretRef } from "../config/types.secrets.js";

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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isSecretProviderConfigShape(value: unknown): value is SecretProviderConfig {
  if (!isObjectRecord(value) || typeof value.source !== "string") {
    return false;
  }

  if (value.source === "env") {
    if (value.allowlist !== undefined && !isStringArray(value.allowlist)) {
      return false;
    }
    return true;
  }

  if (value.source === "file") {
    if (typeof value.path !== "string" || value.path.trim().length === 0) {
      return false;
    }
    if (value.mode !== undefined && value.mode !== "json" && value.mode !== "singleValue") {
      return false;
    }
    return true;
  }

  if (value.source === "exec") {
    if (typeof value.command !== "string" || value.command.trim().length === 0) {
      return false;
    }
    if (value.args !== undefined && !isStringArray(value.args)) {
      return false;
    }
    if (
      value.passEnv !== undefined &&
      (!Array.isArray(value.passEnv) || !value.passEnv.every((entry) => typeof entry === "string"))
    ) {
      return false;
    }
    if (
      value.trustedDirs !== undefined &&
      (!Array.isArray(value.trustedDirs) ||
        !value.trustedDirs.every((entry) => typeof entry === "string"))
    ) {
      return false;
    }
    if (value.allowInsecurePath !== undefined && typeof value.allowInsecurePath !== "boolean") {
      return false;
    }
    if (value.allowSymlinkCommand !== undefined && typeof value.allowSymlinkCommand !== "boolean") {
      return false;
    }
    if (value.env !== undefined) {
      if (!isObjectRecord(value.env)) {
        return false;
      }
      if (!Object.values(value.env).every((entry) => typeof entry === "string")) {
        return false;
      }
    }
    return true;
  }

  return false;
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
