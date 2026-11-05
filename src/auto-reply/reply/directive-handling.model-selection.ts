import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  assertOperatorModelAllowed,
  createOperatorModelSelectionAssertion,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import {
  ensureAuthProfileStoreAsync,
  findPersistedAuthProfileCredentialAsync,
} from "../../agents/auth-profiles/store-runtime.js";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import {
  createModelVisibilityPolicy,
  type ModelVisibilityPolicy,
} from "../../agents/model-visibility-policy.js";
import { resolveOperatorModelDefault } from "../../agents/operator-model-policy.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { prepareUserModelAccountAuthority } from "../../state/user-model-account-operations.js";
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

async function resolveStoredNumericProfileModelDirective(
  raw: string,
  agentDir: string,
): Promise<{
  modelRaw: string;
  profileId: string;
  profileProvider: string;
} | null> {
  const lastSlash = raw.lastIndexOf("/");
  const profileDelimiter = raw.indexOf("@", lastSlash + 1);
  if (profileDelimiter <= 0) {
    return null;
  }

  const profileId = raw.slice(profileDelimiter + 1).trim();
  if (!/^\d{8}$/.test(profileId)) {
    return null;
  }

  const modelRaw = raw.slice(0, profileDelimiter).trim();
  const store = await ensureAuthProfileStoreAsync(agentDir, {
    allowKeychainPrompt: false,
  });
  const profile = store.profiles[profileId];
  return profile ? { modelRaw, profileId, profileProvider: profile.provider } : null;
}

/** Resolves the requested model/profile override from parsed inline directives. */
export async function resolveModelSelectionFromDirective(params: {
  directives: InlineDirectives;
  cfg: OpenClawConfig;
  agentDir: string;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  allowedModelKeys: Set<string>;
  modelPolicy?: ModelVisibilityPolicy;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  agentId?: string;
  requesterProfileId?: string;
}): Promise<{
  modelSelection?: ModelDirectiveSelection;
  profileOverride?: string;
  errorText?: string;
  validateAuthProfileSelection?: () => string | undefined;
  validateModelSelection?: () => string | undefined;
  modelSelectionSource?: SessionSourceAssertion;
}> {
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
      modelSelectionSource: createOperatorModelSelectionAssertion(
        params.operatorAuthority,
        selection,
      ),
    };
  }
  const storedNumericProfile =
    params.directives.rawModelProfile === undefined
      ? await resolveStoredNumericProfileModelDirective(raw, params.agentDir)
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

  const resolved =
    useStoredNumericProfile && storedNumericProfileSelection
      ? storedNumericProfileSelection
      : resolveSelection(raw);
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
    const provider = modelSelection.provider;
    const agentDir = params.agentDir;
    const requesterProfileId = params.requesterProfileId;
    const profileId = normalizeOptionalString(rawProfile);
    if (profileId) {
      let profileProvider: string;
      if (isUserModelAuthProfileId(profileId)) {
        const account = requesterProfileId
          ? await prepareUserModelAccountAuthority({
              profileId: requesterProfileId,
              authProfileId: profileId,
            })
          : undefined;
        const unavailable = "Select a personal model account connected to your signed-in profile.";
        if (!account) {
          return { errorText: unavailable };
        }
        const validateSelection = () => (account.isCurrent() ? undefined : unavailable);
        const selectionError = validateSelection();
        if (selectionError) {
          return { errorText: selectionError };
        }
        profileProvider = account.provider;
        validateAuthProfileSelection = validateSelection;
      } else {
        // Persisted credentials are checked first because they avoid keychain prompts.
        const profile =
          (await findPersistedAuthProfileCredentialAsync({ agentDir, profileId })) ??
          (await ensureAuthProfileStoreAsync(agentDir, { allowKeychainPrompt: false })).profiles[
            profileId
          ];
        if (!profile) {
          return { errorText: `Auth profile "${profileId}" not found.` };
        }
        profileProvider = profile.provider;
      }
      if (profileProvider !== provider) {
        return {
          errorText: `Auth profile "${profileId}" is for ${profileProvider}, not ${provider}.`,
        };
      }
      profileOverride = profileId;
    }
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
          modelSelectionSource: composeSessionSourceAssertion(
            [createOperatorModelSelectionAssertion(params.operatorAuthority, modelSelection)],
            (assertSource) => {
              assertSource();
              const error = validateAuthProfileSelection?.();
              if (error) {
                throw new Error(error);
              }
            },
          ),
        }
      : {}),
  };
}
