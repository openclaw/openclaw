/** Collects auth-profile and OAuth secret refs for runtime preparation. */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { resolveAuthProfileEligibility } from "../agents/auth-profiles/order.js";
import { assertNoOAuthSecretRefPolicyViolations } from "../agents/auth-profiles/policy.js";
import type { AuthProfileCredential, AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { ProviderAuthAliasLookupParams } from "../agents/provider-auth-aliases.js";
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

function collectStaticProfileAssignment(params: {
  profile: StaticProfileCredential;
  profileId: string;
  store: AuthProfileStore;
  agentDir: string;
  defaults: SecretDefaults | undefined;
  authAliasLookupParams: ProviderAuthAliasLookupParams;
  context: ResolverContext;
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
  collectAuthStoreSecretInputAssignment({
    value: ref,
    path: `${params.agentDir}.auth-profiles.${params.profileId}.${field}`,
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    active: eligibility.eligible,
    inactiveReason: `auth profile is not eligible (${eligibility.reasonCode}); skipping resolution until it becomes eligible.`,
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
      });
    }
  }
}
