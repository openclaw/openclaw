import type { SecretRef } from "../config/types.secrets.js";

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
  targets: SecretsPlanTarget[];
  options?: {
    scrubEnv?: boolean;
    scrubAuthProfilesForProviderTargets?: boolean;
    scrubLegacyAuthJson?: boolean;
  };
};

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
