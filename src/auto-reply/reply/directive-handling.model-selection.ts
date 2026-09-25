import {
  assertOperatorModelAllowed,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
/** Resolves /model directive selections and auth profile overrides. */
import { ensureAuthProfileStore } from "../../agents/auth-profiles.js";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import {
  createModelVisibilityPolicy,
  type ModelVisibilityPolicy,
} from "../../agents/model-visibility-policy.js";
import { resolveOperatorModelDefault } from "../../agents/operator-model-policy.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveProfileOverride } from "./directive-handling.auth-profile.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import { type ModelDirectiveSelection, resolveModelDirectiveSelection } from "./model-selection.js";

function validateOperatorSelection(
  authority: AdmittedRunOperatorAuthority | undefined,
  selection: { provider: string; model: string } | undefined,
): string | undefined {
  try {
    assertOperatorModelAllowed(authority, selection);
    return undefined;
  } catch (error) {
    return formatErrorMessage(error);
  }
}

function resolveStoredNumericProfileModelDirective(params: { raw: string; agentDir: string }): {
  modelRaw: string;
  profileId: string;
  profileProvider: string;
} | null {
  const trimmed = params.raw.trim();
  const lastSlash = trimmed.lastIndexOf("/");
  const profileDelimiter = trimmed.indexOf("@", lastSlash + 1);
  if (profileDelimiter <= 0) {
    return null;
  }

  const profileId = trimmed.slice(profileDelimiter + 1).trim();
  if (!/^\d{8}$/.test(profileId)) {
    return null;
  }

  const modelRaw = trimmed.slice(0, profileDelimiter).trim();
  if (!modelRaw) {
    return null;
  }

  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  const profile = store.profiles[profileId];
  if (!profile) {
    return null;
  }

  return { modelRaw, profileId, profileProvider: profile.provider };
}

/** Resolves the requested model/profile override from parsed inline directives. */
export function resolveModelSelectionFromDirective(params: {
  directives: InlineDirectives;
  cfg: OpenClawConfig;
  agentDir: string;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  allowedModelKeys: Set<string>;
  modelPolicy?: ModelVisibilityPolicy;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  allowedModelCatalog: Array<{ provider: string; id?: string; name?: string }>;
  provider: string;
  agentId?: string;
  requesterProfileId?: string;
}): {
  modelSelection?: ModelDirectiveSelection;
  profileOverride?: string;
  errorText?: string;
  validateAuthProfileSelection?: () => string | undefined;
  validateModelSelection?: () => string | undefined;
} {
  if (!params.directives.hasModelDirective || !params.directives.rawModelDirective) {
    if (params.directives.rawModelProfile) {
      return { errorText: "Auth profile override requires a model selection." };
    }
    return {};
  }

  const raw = params.directives.rawModelDirective.trim();
  if (/^default$/i.test(raw)) {
    const policy =
      params.modelPolicy ??
      createModelVisibilityPolicy({
        cfg: params.cfg,
        agentId: params.agentId,
        catalog: [],
        defaultProvider: params.defaultProvider,
        defaultModel: params.defaultModel,
      });
    const selection = resolveOperatorModelDefault({
      cfg: params.cfg,
      agentId: params.agentId,
      policy: params.operatorAuthority?.modelPolicy,
      model: { provider: params.defaultProvider, model: params.defaultModel },
      allows: policy.allows,
    });
    const errorText = validateOperatorSelection(params.operatorAuthority, selection);
    if (errorText) {
      return { errorText };
    }
    if (!selection) {
      return { errorText: "No model is available for this operator role and agent." };
    }
    return {
      modelSelection: {
        ...selection,
        isDefault: true,
        resetToDefault: true,
      },
      validateModelSelection: () => validateOperatorSelection(params.operatorAuthority, selection),
    };
  }
  const storedNumericProfile =
    params.directives.rawModelProfile === undefined
      ? resolveStoredNumericProfileModelDirective({
          raw,
          agentDir: params.agentDir,
        })
      : null;
  const resolveSelection = (directive: string) =>
    resolveModelDirectiveSelection({
      raw: directive,
      defaultProvider: params.defaultProvider,
      defaultModel: params.defaultModel,
      aliasIndex: params.aliasIndex,
      allowedModelKeys: params.allowedModelKeys,
      modelPolicy: params.modelPolicy,
      operatorModelPolicy: params.operatorAuthority?.modelPolicy,
      cfg: params.cfg,
      agentId: params.agentId,
      rawRuntime: params.directives.rawModelRuntime,
    });
  const storedNumericProfileSelection = storedNumericProfile
    ? resolveSelection(storedNumericProfile.modelRaw)
    : null;
  const useStoredNumericProfile =
    Boolean(storedNumericProfileSelection?.selection) &&
    resolveProviderIdForAuth(storedNumericProfileSelection?.selection?.provider ?? "", {
      config: params.cfg,
    }) ===
      resolveProviderIdForAuth(storedNumericProfile?.profileProvider ?? "", {
        config: params.cfg,
        storedCredential: true,
      });
  const modelRaw =
    useStoredNumericProfile && storedNumericProfile ? storedNumericProfile.modelRaw : raw;

  if (/^[0-9]+$/.test(raw)) {
    return {
      errorText: [
        "Numeric model selection is not supported in chat.",
        "",
        "Browse: /models or /models <provider>",
        "Switch: /model <provider/model>",
      ].join("\n"),
    };
  }

  const resolved = resolveSelection(modelRaw);
  if (resolved.error) {
    return { errorText: resolved.error };
  }
  const modelSelection = resolved.selection;
  if (modelSelection) {
    const errorText = validateOperatorSelection(params.operatorAuthority, modelSelection);
    if (errorText) {
      return { errorText };
    }
  }

  let profileOverride: string | undefined;
  let validateAuthProfileSelection: (() => string | undefined) | undefined;
  const rawProfile =
    params.directives.rawModelProfile ??
    (useStoredNumericProfile ? storedNumericProfile?.profileId : undefined);
  if (modelSelection && rawProfile) {
    const profileResolved = resolveProfileOverride({
      rawProfile,
      provider: modelSelection.provider,
      cfg: params.cfg,
      agentDir: params.agentDir,
      requesterProfileId: params.requesterProfileId,
    });
    if (profileResolved.error) {
      return { errorText: profileResolved.error };
    }
    profileOverride = profileResolved.profileId;
    validateAuthProfileSelection = profileResolved.validateSelection;
  }

  return {
    modelSelection,
    profileOverride,
    ...(validateAuthProfileSelection ? { validateAuthProfileSelection } : {}),
    ...(modelSelection
      ? {
          validateModelSelection: () =>
            validateOperatorSelection(params.operatorAuthority, modelSelection) ??
            validateAuthProfileSelection?.(),
        }
      : {}),
  };
}
