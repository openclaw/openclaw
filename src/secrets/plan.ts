/** Validates and normalizes serialized secrets apply plans before config mutation. */
import { isRecord as isObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { SecretProviderConfig, SecretRef } from "../config/types.secrets.js";
import { SecretProviderSchema } from "../config/zod-schema.core.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import {
  parseConcreteConfigPathTokens,
  type ConcreteConfigPathSegment,
} from "../shared/dot-path.js";
import { isValidSecretProviderAlias, isValidSecretRef } from "./ref-contract.js";
import { resolvePlanTargetAgainstRegistry, type ResolvedPlanTarget } from "./target-registry.js";

/** One planned SecretRef mutation against config or auth-profile storage. */
export type SecretsPlanTarget = {
  type: string;
  /**
   * Dot path in the target config surface for operator readability.
   * Examples:
   * - "models.providers.openai.apiKey"
   * - "profiles.openai.key"
   */
  path: string;
  /**
   * Canonical path segments used for safe mutation.
   * Examples:
   * - ["models", "providers", "openai", "apiKey"]
   * - ["profiles", "openai", "key"]
   */
  pathSegments?: string[];
  ref: SecretRef;
  /**
   * Required for auth-profiles targets so apply can resolve the correct agent store.
   */
  agentId?: string;
  /**
   * Explicit auth-profile store owner. `"shared"` routes the target to the
   * canonical shared state database, `"agent"` to the selected agent database.
   * Omitted preserves legacy agent-database behavior; any other value is rejected.
   */
  authProfileStore?: string;
  /**
   * For provider targets, used to scrub auth-profile/static residues.
   */
  providerId?: string;
  /** For account-scoped channel targets. */
  accountId?: string;
  /**
   * Optional auth-profile provider value used when creating new auth profile mappings.
   */
  authProfileProvider?: string;
};

/**
 * Plan protocol revision accepted by every released reader: all targets write
 * agent-local auth stores. Plans at this revision stay readable by older
 * installations.
 */
export const SECRETS_PLAN_PROTOCOL_VERSION = 1;

/**
 * Protocol revision for plans that carry at least one shared-store target
 * (`authProfileStore: "shared"`). Released readers only accept revision 1 and
 * ignore `authProfileStore`, so they would apply such a target to the agent
 * database and report success while leaving the shared store untouched.
 * Emitting revision 2 makes an older installation reject the file instead.
 */
export const SECRETS_PLAN_SHARED_PROTOCOL_VERSION = 2;

/** Accepted secrets apply plan protocol revisions. */
type SecretsPlanProtocolVersion =
  | typeof SECRETS_PLAN_PROTOCOL_VERSION
  | typeof SECRETS_PLAN_SHARED_PROTOCOL_VERSION;

/** Serialized plan produced by `openclaw secrets configure` or supplied manually. */
export type SecretsApplyPlan = {
  version: 1;
  protocolVersion: SecretsPlanProtocolVersion;
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

/** Resolves a user-supplied plan target through the registry after path safety checks. */
export function resolveValidatedPlanTarget(
  candidate: Partial<Omit<SecretsPlanTarget, "ref">>,
): ResolvedPlanTarget | null {
  if (typeof candidate.type !== "string" || !candidate.type.trim()) {
    return null;
  }
  const path = typeof candidate.path === "string" ? candidate.path.trim() : "";
  if (!path) {
    return null;
  }
  let parsedTokens: ConcreteConfigPathSegment[];
  let segments: string[];
  const hasPathSegments =
    Array.isArray(candidate.pathSegments) && candidate.pathSegments.length > 0;
  try {
    parsedTokens = parseConcreteConfigPathTokens(path);
    segments = hasPathSegments
      ? normalizeStringEntries(candidate.pathSegments)
      : parsedTokens.map(String);
  } catch {
    return null;
  }
  const parsedPathMatches =
    segments.length === parsedTokens.length &&
    segments.every((segment, index) => segment === String(parsedTokens[index]));
  if (
    segments.length === 0 ||
    segments.some(isBlockedObjectKey) ||
    (!parsedPathMatches && path !== segments.join("."))
  ) {
    return null;
  }
  // Registry resolution is the ownership gate; caller-provided paths must map to a known
  // mutable SecretRef target before apply code can write anything.
  return resolvePlanTargetAgainstRegistry({
    type: candidate.type,
    pathSegments: segments,
    pathTokens: parsedPathMatches ? parsedTokens : segments,
    // Only an authored array pattern can disambiguate indices in shipped v1 dotted plans.
    allowLegacyArrayString: path === segments.join("."),
    providerId: candidate.providerId,
    accountId: candidate.accountId,
  });
}

/** Validates the external secrets apply plan shape and every target/provider mutation. */
export function isSecretsApplyPlan(value: unknown): value is SecretsApplyPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const typed = value as Partial<SecretsApplyPlan>;
  const protocolVersion = typed.protocolVersion;
  if (
    typed.version !== 1 ||
    (protocolVersion !== SECRETS_PLAN_PROTOCOL_VERSION &&
      protocolVersion !== SECRETS_PLAN_SHARED_PROTOCOL_VERSION) ||
    !Array.isArray(typed.targets)
  ) {
    return false;
  }
  let usesSharedStore = false;
  for (const target of typed.targets) {
    if (!target || typeof target !== "object") {
      return false;
    }
    const candidate = target as Partial<SecretsPlanTarget>;
    const resolved = resolveValidatedPlanTarget(candidate);
    if (
      (candidate.pathSegments !== undefined && !Array.isArray(candidate.pathSegments)) ||
      !resolved ||
      !candidate.ref ||
      !isValidSecretRef(candidate.ref)
    ) {
      return false;
    }
    if (
      candidate.authProfileStore !== undefined &&
      candidate.authProfileStore !== "agent" &&
      candidate.authProfileStore !== "shared"
    ) {
      return false;
    }
    if (resolved.entry.configFile === "auth-profile-store") {
      if (typeof candidate.agentId !== "string" || candidate.agentId.trim().length === 0) {
        return false;
      }
      if (
        candidate.authProfileProvider !== undefined &&
        (typeof candidate.authProfileProvider !== "string" ||
          candidate.authProfileProvider.trim().length === 0)
      ) {
        return false;
      }
      if (candidate.authProfileStore === "shared") {
        usesSharedStore = true;
      }
    }
  }
  // The protocol revision is the compatibility guard for shared ownership: an older
  // reader accepts revision 1 and ignores `authProfileStore`, so a shared target must
  // not be encodable there. Revision 2 in turn may only appear when a shared target
  // is actually present, which keeps agent-local plans readable by older readers.
  if (usesSharedStore !== (protocolVersion === SECRETS_PLAN_SHARED_PROTOCOL_VERSION)) {
    return false;
  }
  if (typed.providerUpserts !== undefined) {
    if (!isObjectRecord(typed.providerUpserts)) {
      return false;
    }
    for (const [providerAlias, providerValue] of Object.entries(typed.providerUpserts)) {
      if (!isValidSecretProviderAlias(providerAlias)) {
        return false;
      }
      if (!SecretProviderSchema.safeParse(providerValue).success) {
        return false;
      }
    }
  }
  if (typed.providerDeletes !== undefined) {
    if (
      !Array.isArray(typed.providerDeletes) ||
      typed.providerDeletes.some(
        (providerAlias) =>
          typeof providerAlias !== "string" || !isValidSecretProviderAlias(providerAlias),
      )
    ) {
      return false;
    }
  }
  return true;
}

/** Normalizes omitted plan options to the apply-time defaults. */
export function normalizeSecretsPlanOptions(
  options: SecretsApplyPlan["options"] | undefined,
): Required<NonNullable<SecretsApplyPlan["options"]>> {
  return {
    scrubEnv: options?.scrubEnv ?? true,
    scrubAuthProfilesForProviderTargets: options?.scrubAuthProfilesForProviderTargets ?? true,
    // Deprecated plan input retained for protocol compatibility. Doctor owns
    // legacy auth.json migration; secrets apply never reads or rewrites it.
    scrubLegacyAuthJson: false,
  };
}
