/** Collects auth-profile and OAuth secret refs for runtime preparation. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import {
  resolveAuthProfileDeploymentCandidates,
  resolveAuthProfileEligibility,
} from "../agents/auth-profiles/order.js";
import { assertNoOAuthSecretRefPolicyViolations } from "../agents/auth-profiles/policy.js";
import type { AuthProfileCredential, AuthProfileStore } from "../agents/auth-profiles/types.js";
import { resolveProviderEntryApiKeyProfileReference } from "../agents/model-auth-provider-config.js";
import {
  resolveProviderIdForAuth,
  type ProviderAuthAliasLookupParams,
} from "../agents/provider-auth-aliases.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { setSecretAssignmentSource } from "./runtime-assignment-provenance.js";
import { resolveAuthProfileSecretOwnerId } from "./runtime-auth-profile-owner.js";
import {
  collectRuntimeSecretInputAssignment,
  pushWarning,
  type ResolverContext,
  type SecretDefaults,
} from "./runtime-shared.js";
import { isNonEmptyString } from "./shared.js";

type StaticProfileCredential = Extract<AuthProfileCredential, { type: "api_key" | "token" }>;

function resolveAuthProfileOwnerContract(
  profile: StaticProfileCredential,
  context: ResolverContext,
): unknown {
  const providerId = normalizeOptionalLowercaseString(profile.provider) ?? profile.provider;
  const configuredProvider = Object.entries(context.sourceConfig.models?.providers ?? {}).find(
    ([candidateId]) =>
      (normalizeOptionalLowercaseString(candidateId) ?? candidateId) === providerId,
  );
  return {
    profile: structuredClone(profile),
    providerId,
    configuredProvider,
  };
}

function collectAuthStoreSecretInputAssignment(
  params: Parameters<typeof collectRuntimeSecretInputAssignment>[0],
): void {
  const previousCount = params.context.assignments.length;
  collectRuntimeSecretInputAssignment(params);
  for (const assignment of params.context.assignments.slice(previousCount)) {
    setSecretAssignmentSource(assignment, "auth-store");
  }
}

type ProviderAuthOrderInfo = {
  hasExplicitOrder: boolean;
  profileIds: Set<string>;
};

function collectStaticProfileAssignment(params: {
  profile: StaticProfileCredential;
  profileId: string;
  store: AuthProfileStore;
  agentDir: string;
  defaults: SecretDefaults | undefined;
  authAliasLookupParams: ProviderAuthAliasLookupParams;
  context: ResolverContext;
  providerAuthOrder: ProviderAuthOrderInfo;
  configBoundProfileIds: Set<string>;
}): void {
  const ownerContract = resolveAuthProfileOwnerContract(params.profile, params.context);
  const profile = params.profile;
  const field = profile.type === "api_key" ? "key" : "token";
  const { explicitRef, inlineRef, ref } = resolveSecretInputRef({
    value: profile.type === "api_key" ? profile.key : profile.token,
    refValue: profile.type === "api_key" ? profile.keyRef : profile.tokenRef,
    defaults: params.defaults,
  });
  if (!ref) {
    return;
  }
  // Promote inline refs before eligibility reads the authoritative ref field.
  if (!explicitRef && inlineRef) {
    if (profile.type === "api_key") {
      profile.keyRef = inlineRef;
    } else {
      profile.tokenRef = inlineRef;
    }
  }
  if (explicitRef && isNonEmptyString(profile.type === "api_key" ? profile.key : profile.token)) {
    pushWarning(params.context, {
      code: "SECRETS_REF_OVERRIDES_PLAINTEXT",
      path: `${params.agentDir}.auth-profiles.${params.profileId}.${field}`,
      message: `auth-profiles ${params.profileId}: ${field}Ref is set; runtime will ignore plaintext ${field}.`,
    });
  }
  const setValue =
    profile.type === "api_key"
      ? (value: string | undefined) => {
          profile.key = value;
        }
      : (value: string | undefined) => {
          profile.token = value;
        };
  // Only successful runtime materialization may populate the authoritative secret slot.
  setValue(undefined);
  const eligibility = resolveAuthProfileEligibility({
    cfg: params.context.sourceConfig,
    authAliasLookupParams: params.authAliasLookupParams,
    store: params.store,
    provider: profile.provider,
    profileId: params.profileId,
  });
  const isConfigBoundProfile =
    params.configBoundProfileIds.has(params.profileId) ||
    params.context.configBoundProfileIds?.has(params.profileId) === true;
  let active = eligibility.eligible;
  let inactiveReason = `auth profile is not eligible (${eligibility.reasonCode}); skipping resolution until it becomes eligible.`;
  // Strict paths cannot tolerate resolution of unrelated refs: an explicit
  // auth.order that omits this profile excludes it, so it is never collected.
  // Degrade-capable paths (Gateway) keep wide collection and tolerate failures.
  if (
    active &&
    params.context.allowOwnerIsolation !== true &&
    params.providerAuthOrder.hasExplicitOrder &&
    !params.providerAuthOrder.profileIds.has(params.profileId) &&
    !isConfigBoundProfile
  ) {
    active = false;
    inactiveReason = "Excluded by auth.order for this provider.";
  }
  collectAuthStoreSecretInputAssignment({
    value: ref,
    path: `${params.agentDir}.auth-profiles.${params.profileId}.${field}`,
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    active,
    inactiveReason,
    owner: {
      ownerKind: "account",
      ownerId: resolveAuthProfileSecretOwnerId(params),
      requiredForGateway: false,
      disposition: "isolate",
      contract: ownerContract,
    },
    apply: (value) => {
      setValue(String(value));
    },
    applyUnavailable: () => {
      setValue(undefined);
    },
  });
}

/** Collects SecretRef assignments from agent auth-profile stores for runtime materialization. */
export function collectAuthStoreAssignments(params: {
  store: AuthProfileStore;
  context: ResolverContext;
  agentDir: string;
}): void {
  assertNoOAuthSecretRefPolicyViolations({
    store: params.store,
    cfg: params.context.sourceConfig,
    context: `auth-profiles ${params.agentDir}`,
  });

  const defaults = params.context.sourceConfig.secrets?.defaults;
  const authAliasLookupParams: ProviderAuthAliasLookupParams = {
    env: params.context.env,
    ...(params.context.manifestRegistry
      ? { metadataSnapshot: params.context.manifestRegistry }
      : {}),
  };
  const providerAuthOrderCache = new Map<string, ProviderAuthOrderInfo>();
  const configBoundByProviderAuthKey = new Map<string, Set<string>>();
  // Detect config-bound profiles across every configured provider entry, not only
  // the credential's own provider. A bearer profile referenced by any compatible
  // entry's apiKey (including split-provider entries whose endpoints match) stays
  // effective even when excluded by auth.order.
  const resolveConfigBoundProfileIds = (provider: string): Set<string> => {
    const providerKey = normalizeProviderId(provider);
    const providerAuthKey = resolveProviderIdForAuth(provider, {
      config: params.context.sourceConfig,
      ...authAliasLookupParams,
    });
    const cacheKey = `${providerKey}\u0000${providerAuthKey}`;
    const cached = configBoundByProviderAuthKey.get(cacheKey);
    if (cached) {
      return cached;
    }
    const bound = new Set<string>();
    for (const [entryId] of Object.entries(params.context.sourceConfig.models?.providers ?? {})) {
      const reference = resolveProviderEntryApiKeyProfileReference({
        cfg: params.context.sourceConfig,
        authAliasLookupParams,
        provider: entryId,
        store: params.store,
      });
      if (reference.kind === "profile") {
        bound.add(reference.profileId);
      }
    }
    configBoundByProviderAuthKey.set(cacheKey, bound);
    return bound;
  };
  const resolveProviderAuthOrder = (provider: string): ProviderAuthOrderInfo => {
    const providerKey = normalizeProviderId(provider);
    const providerAuthKey = resolveProviderIdForAuth(provider, {
      config: params.context.sourceConfig,
      ...authAliasLookupParams,
    });
    const cacheKey = `${providerKey}\u0000${providerAuthKey}`;
    const cached = providerAuthOrderCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const deployment = resolveAuthProfileDeploymentCandidates({
      cfg: params.context.sourceConfig,
      store: params.store,
      provider,
      authAliasLookupParams,
      pinnedProfileId: params.context.pinnedProfileId,
    });
    const entry: ProviderAuthOrderInfo = {
      hasExplicitOrder: deployment.hasExplicitOrder,
      profileIds: deployment.profileIds,
    };
    providerAuthOrderCache.set(cacheKey, entry);
    return entry;
  };
  for (const [profileId, profile] of Object.entries(params.store.profiles)) {
    if (profile.type === "api_key" || profile.type === "token") {
      collectStaticProfileAssignment({
        profile,
        profileId,
        store: params.store,
        agentDir: params.agentDir,
        defaults,
        authAliasLookupParams,
        context: params.context,
        providerAuthOrder: resolveProviderAuthOrder(profile.provider),
        configBoundProfileIds: resolveConfigBoundProfileIds(profile.provider),
      });
    }
  }
}
