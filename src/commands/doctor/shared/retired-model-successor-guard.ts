import type { createModelAuthAvailabilityResolver } from "../../../agents/model-auth-availability.js";
import { splitTrailingAuthProfile } from "../../../agents/model-ref-profile.js";
import {
  canonicalizeProviderModelId,
  projectProviderModelRouteConfig,
} from "../../../agents/provider-model-route.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { buildManifestBuiltInModelSuppressionResolver } from "../../../plugins/manifest-model-suppression.js";
import type { ModelRefRepair, ModelRetirementScope } from "./retired-model-ref-repair.types.js";

export type SuccessorGuardOwner = {
  suppression(
    config?: OpenClawConfig,
  ): ReturnType<typeof buildManifestBuiltInModelSuppressionResolver>;
  auth(
    profileId: string | undefined,
    config?: OpenClawConfig,
  ): ReturnType<typeof createModelAuthAvailabilityResolver>;
  successorConfig(change: {
    sourceModelRef: string;
    successorModelRef: string;
    retirementScope: ModelRetirementScope;
  }): OpenClawConfig;
};

// Validates a declared retirement successor against the same owner context
// before Doctor migrates saved references onto it (#156155). Only an
// explicitly retired or definitively unsupported successor blocks the
// migration; missing evidence is not proof.
export function resolveSuccessorModelRepair(params: {
  owner: SuccessorGuardOwner;
  provider: string;
  canonical: string;
  agentId: string;
  modelRefInput: string;
  authProfileId?: string;
  authProfileSource?: SessionEntry["authProfileOverrideSource"];
  retirement: { replacedBy?: string };
  retirementScope: ModelRetirementScope;
  suppressionConfig?: OpenClawConfig;
  suppressionBaseUrl?: string;
  preserved: ModelRefRepair;
  validatePolicy: (repair: ModelRefRepair) => ModelRefRepair;
  warn: (message: string) => void;
}): ModelRefRepair {
  const { owner, provider, canonical, agentId } = params;
  const successor = params.retirement.replacedBy;
  if (!successor) {
    return {
      kind: "clear",
      provider,
      modelRef: canonical,
      retirementScope: params.retirementScope,
    };
  }
  const successorId = canonicalizeProviderModelId(provider, successor);
  const successorConfig = owner.successorConfig({
    sourceModelRef: canonical,
    successorModelRef: `${provider}/${successor}`,
    retirementScope: params.retirementScope,
  });
  const parsed = splitTrailingAuthProfile(params.modelRefInput);
  const pinnedProfileId =
    (params.authProfileSource === "user" || params.authProfileSource === "user-link"
      ? params.authProfileId
      : undefined) ?? parsed.profile;
  const preferredProfileId = pinnedProfileId ? undefined : params.authProfileId;
  const support = owner
    .auth(pinnedProfileId ?? preferredProfileId, successorConfig)
    .evaluateRuntimeModelAuth(provider, {
      modelId: successorId,
      pinnedProfileId,
      preferredProfileId,
    });
  if (
    support.availability === false &&
    (support.routeResolution?.kind === "incompatible" ||
      (support.availabilityAuthoritative && support.unavailableReason !== "cooldown"))
  ) {
    params.warn(
      `Retained ${canonical} for agent "${agentId}": successor "${provider}/${successor}" is not supported by this agent's authentication route. Choose a supported model explicitly and rerun openclaw doctor --fix.`,
    );
    return params.validatePolicy(params.preserved);
  }
  const routeConfig = support.selectedRoute
    ? projectProviderModelRouteConfig({
        provider,
        config: successorConfig,
        route: support.selectedRoute,
      })
    : params.suppressionConfig;
  const successorRule = routeConfig
    ? owner.suppression(routeConfig)({
        provider,
        id: successorId,
        baseUrl: support.selectedRoute?.baseUrl ?? params.suppressionBaseUrl,
      })
    : owner.suppression()({ provider, id: successorId, unconditionalOnly: true });
  if (successorRule?.retirement) {
    params.warn(
      `Retained ${canonical} for agent "${agentId}": successor "${provider}/${successor}" is retired. Choose a supported model explicitly and rerun openclaw doctor --fix.`,
    );
    return params.validatePolicy(params.preserved);
  }
  const modelRef = `${provider}/${successor}`;
  return params.validatePolicy({
    kind: "replace",
    modelRef: parsed.profile ? `${modelRef}@${parsed.profile}` : modelRef,
    reason: "retirement",
    retirementScope: params.retirementScope,
  });
}
