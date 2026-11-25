/** Collects auth-profile and OAuth secret refs for runtime preparation. */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { resolveAuthProfileEligibility } from "../agents/auth-profiles/order.js";
import { assertNoOAuthSecretRefPolicyViolations } from "../agents/auth-profiles/policy.js";
import type { AuthProfileCredential, AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { ProviderAuthAliasLookupParams } from "../agents/provider-auth-aliases.js";
import { parseSecretRef } from "../config/types.secrets.js";
import { setSecretAssignmentSource } from "./runtime-assignment-provenance.js";
import { resolveAuthProfileSecretOwnerId } from "./runtime-auth-profile-owner.js";
import {
  collectCanonicalSecretInputAssignment as collectSecretInputAssignment,
  pushWarning,
  type ResolverContext,
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
  params: Parameters<typeof collectSecretInputAssignment>[0],
): void {
  const previousCount = params.context.assignments.length;
  collectSecretInputAssignment(params);
  for (const assignment of params.context.assignments.slice(previousCount)) {
    setSecretAssignmentSource(assignment, "auth-store");
  }
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
      const store = params.store;
      const agentDir = params.agentDir;
      const context = params.context;
      const ownerContract = resolveAuthProfileOwnerContract(profile, context);
      const field = profile.type === "api_key" ? "key" : "token";
      const explicitRef = parseSecretRef(
        profile.type === "api_key" ? profile.keyRef : profile.tokenRef,
        defaults,
      );
      const inlineRef = explicitRef
        ? null
        : parseSecretRef(profile.type === "api_key" ? profile.key : profile.token, defaults);
      const ref = explicitRef ?? inlineRef;
      if (!ref) {
        continue;
      }
      // Promote inline refs before eligibility reads the authoritative ref field.
      if (!explicitRef && inlineRef) {
        if (profile.type === "api_key") {
          profile.keyRef = inlineRef;
        } else {
          profile.tokenRef = inlineRef;
        }
      }
      if (
        explicitRef &&
        isNonEmptyString(profile.type === "api_key" ? profile.key : profile.token)
      ) {
        pushWarning(context, {
          code: "SECRETS_REF_OVERRIDES_PLAINTEXT",
          path: `${agentDir}.auth-profiles.${profileId}.${field}`,
          message: `auth-profiles ${profileId}: ${field}Ref is set; runtime will ignore plaintext ${field}.`,
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
        cfg: context.sourceConfig,
        authAliasLookupParams,
        store,
        provider: profile.provider,
        profileId,
      });
      collectAuthStoreSecretInputAssignment({
        value: ref,
        path: `${agentDir}.auth-profiles.${profileId}.${field}`,
        expected: "string",
        defaults,
        context,
        active: eligibility.eligible,
        inactiveReason: `auth profile is not eligible (${eligibility.reasonCode}); skipping resolution until it becomes eligible.`,
        owner: {
          ownerKind: "account",
          ownerId: resolveAuthProfileSecretOwnerId({ agentDir, profileId }),
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
  }
}
