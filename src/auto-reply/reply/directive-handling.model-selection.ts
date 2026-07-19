/** Resolves /model directive selections and auth profile overrides. */
import { ensureAuthProfileStore } from "../../agents/auth-profiles.js";
import { isModelKeyAllowedBySet } from "../../agents/model-selection-shared.js";
import {
  type ModelAliasIndex,
  modelKey,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveProfileOverride } from "./directive-handling.auth-profile.js";
import {
  applyModelRuntimeDirective,
  resolveModelRuntimeDirective,
  type ModelRuntimeDirectiveResolution,
} from "./directive-handling.model-runtime.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import { type ModelDirectiveSelection, resolveModelDirectiveSelection } from "./model-selection.js";

export type PreparedModelDirectiveEffect =
  | { kind: "none" }
  | { kind: "invalid"; errorText: string }
  | {
      kind: "selection";
      modelSelection: ModelDirectiveSelection;
      profileOverride?: string;
      runtimeResolution: Exclude<ModelRuntimeDirectiveResolution, { kind: "invalid" }>;
      runtime: string;
    };

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
  allowedModelCatalog: Array<{ provider: string; id?: string; name?: string }>;
  provider: string;
  agentId?: string;
}): {
  modelSelection?: ModelDirectiveSelection;
  profileOverride?: string;
  errorText?: string;
} {
  if (!params.directives.hasModelDirective || !params.directives.rawModelDirective) {
    if (params.directives.rawModelProfile) {
      return { errorText: "Auth profile override requires a model selection." };
    }
    return {};
  }

  const raw = params.directives.rawModelDirective.trim();
  if (/^default$/i.test(raw)) {
    return {
      modelSelection: {
        provider: params.defaultProvider,
        model: params.defaultModel,
        isDefault: true,
      },
    };
  }
  const storedNumericProfile =
    params.directives.rawModelProfile === undefined
      ? resolveStoredNumericProfileModelDirective({
          raw,
          agentDir: params.agentDir,
        })
      : null;
  const storedNumericProfileSelection = storedNumericProfile
    ? resolveModelDirectiveSelection({
        raw: storedNumericProfile.modelRaw,
        defaultProvider: params.defaultProvider,
        defaultModel: params.defaultModel,
        aliasIndex: params.aliasIndex,
        allowedModelKeys: params.allowedModelKeys,
        cfg: params.cfg,
        agentId: params.agentId,
        rawRuntime: params.directives.rawModelRuntime,
      })
    : null;
  const useStoredNumericProfile =
    Boolean(storedNumericProfileSelection?.selection) &&
    resolveProviderIdForAuth(storedNumericProfileSelection?.selection?.provider ?? "", {
      config: params.cfg,
    }) ===
      resolveProviderIdForAuth(storedNumericProfile?.profileProvider ?? "", {
        config: params.cfg,
      });
  const modelRaw =
    useStoredNumericProfile && storedNumericProfile ? storedNumericProfile.modelRaw : raw;
  let modelSelection: ModelDirectiveSelection | undefined;

  const explicit = resolveModelRefFromString({
    raw: modelRaw,
    defaultProvider: params.defaultProvider,
    aliasIndex: params.aliasIndex,
  });
  if (explicit) {
    const explicitKey = modelKey(explicit.ref.provider, explicit.ref.model);
    if (
      params.allowedModelKeys.size === 0 ||
      isModelKeyAllowedBySet(params.allowedModelKeys, explicitKey)
    ) {
      modelSelection = {
        provider: explicit.ref.provider,
        model: explicit.ref.model,
        isDefault:
          explicit.ref.provider === params.defaultProvider &&
          explicit.ref.model === params.defaultModel,
        ...(explicit.alias ? { alias: explicit.alias } : {}),
      };
    }
  }

  // Configured aliases may be numeric (for example a channel picker value).
  // Reject only an unresolved bare number, never an alias already bound above.
  if (!modelSelection && /^[0-9]+$/.test(raw)) {
    return {
      errorText: [
        "Numeric model selection is not supported in chat.",
        "",
        "Browse: /models or /models <provider>",
        "Switch: /model <provider/model>",
      ].join("\n"),
    };
  }

  if (!modelSelection) {
    const resolved = resolveModelDirectiveSelection({
      raw: modelRaw,
      defaultProvider: params.defaultProvider,
      defaultModel: params.defaultModel,
      aliasIndex: params.aliasIndex,
      allowedModelKeys: params.allowedModelKeys,
      cfg: params.cfg,
      agentId: params.agentId,
      rawRuntime: params.directives.rawModelRuntime,
    });

    if (resolved.error) {
      return { errorText: resolved.error };
    }

    if (resolved.selection) {
      modelSelection = resolved.selection;
    }
  }

  let profileOverride: string | undefined;
  const rawProfile =
    params.directives.rawModelProfile ??
    (useStoredNumericProfile ? storedNumericProfile?.profileId : undefined);
  if (modelSelection && rawProfile) {
    const profileResolved = resolveProfileOverride({
      rawProfile,
      provider: modelSelection.provider,
      cfg: params.cfg,
      agentDir: params.agentDir,
    });
    if (profileResolved.error) {
      return { errorText: profileResolved.error };
    }
    profileOverride = profileResolved.profileId;
  }

  return { modelSelection, profileOverride };
}

/** Resolves the exact model/profile/runtime effect before policy or session mutation. */
export function prepareModelDirectiveEffect(params: {
  directives: InlineDirectives;
  effectiveModelDirective?: string;
  cfg: OpenClawConfig;
  agentDir: string;
  agentId?: string;
  sessionKey?: string;
  sessionEntry?: Pick<SessionEntry, "agentHarnessId" | "agentRuntimeOverride">;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  allowedModelKeys: Set<string>;
  allowedModelCatalog: Array<{ provider: string; id?: string; name?: string }>;
  provider: string;
}): PreparedModelDirectiveEffect {
  if (!params.directives.hasModelDirective || !params.effectiveModelDirective) {
    return { kind: "none" };
  }
  const modelResolution = resolveModelSelectionFromDirective({
    directives: {
      ...params.directives,
      rawModelDirective: params.effectiveModelDirective,
    },
    cfg: params.cfg,
    agentDir: params.agentDir,
    agentId: params.agentId,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
    aliasIndex: params.aliasIndex,
    allowedModelKeys: params.allowedModelKeys,
    allowedModelCatalog: params.allowedModelCatalog,
    provider: params.provider,
  });
  if (modelResolution.errorText) {
    return { kind: "invalid", errorText: modelResolution.errorText };
  }
  if (!modelResolution.modelSelection) {
    return { kind: "none" };
  }
  const runtimeResolution = resolveModelRuntimeDirective({
    rawRuntime: params.directives.rawModelRuntime,
    provider: modelResolution.modelSelection.provider,
    cfg: params.cfg,
    sessionEntry: params.sessionEntry,
  });
  if (runtimeResolution.kind === "invalid") {
    return { kind: "invalid", errorText: runtimeResolution.errorText };
  }
  const prospectiveSessionEntry = { ...params.sessionEntry };
  applyModelRuntimeDirective(prospectiveSessionEntry, runtimeResolution);
  return {
    kind: "selection",
    modelSelection: modelResolution.modelSelection,
    ...(modelResolution.profileOverride
      ? { profileOverride: modelResolution.profileOverride }
      : {}),
    runtimeResolution,
    runtime: resolveEffectiveAgentRuntime({
      cfg: params.cfg,
      provider: modelResolution.modelSelection.provider,
      modelId: modelResolution.modelSelection.model,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      sessionEntry: prospectiveSessionEntry,
    }),
  };
}
