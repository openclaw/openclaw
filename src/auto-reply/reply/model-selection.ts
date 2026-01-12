import { lookupContextTokens } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { loadModelCatalog } from "../../agents/model-catalog.js";
import {
  buildAllowedModelSet,
  type ModelAliasIndex,
  modelKey,
  normalizeProviderId,
  resolveModelRefFromString,
  resolveThinkingDefault,
} from "../../agents/model-selection.js";
import type { ClawdbotConfig } from "../../config/config.js";
import { type SessionEntry, saveSessionStore } from "../../config/sessions.js";
import type { ThinkLevel } from "./directives.js";

export type ModelDirectiveSelection = {
  provider: string;
  model: string;
  isDefault: boolean;
  alias?: string;
};

type ModelCatalog = Awaited<ReturnType<typeof loadModelCatalog>>;

type ModelSelectionState = {
  provider: string;
  model: string;
  allowedModelKeys: Set<string>;
  allowedModelCatalog: ModelCatalog;
  resetModelOverride: boolean;
  resolveDefaultThinkingLevel: () => Promise<ThinkLevel | undefined>;
  needsModelCatalog: boolean;
};

export async function createModelSelectionState(params: {
  cfg: ClawdbotConfig;
  agentCfg:
    | NonNullable<NonNullable<ClawdbotConfig["agents"]>["defaults"]>
    | undefined;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  defaultProvider: string;
  defaultModel: string;
  provider: string;
  model: string;
  hasModelDirective: boolean;
}): Promise<ModelSelectionState> {
  const {
    cfg,
    agentCfg,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    defaultProvider,
    defaultModel,
  } = params;

  let provider = params.provider;
  let model = params.model;

  const hasAllowlist =
    agentCfg?.models && Object.keys(agentCfg.models).length > 0;
  const hasStoredOverride = Boolean(
    sessionEntry?.modelOverride || sessionEntry?.providerOverride,
  );
  const needsModelCatalog =
    params.hasModelDirective || hasAllowlist || hasStoredOverride;

  let allowedModelKeys = new Set<string>();
  let allowedModelCatalog: ModelCatalog = [];
  let modelCatalog: ModelCatalog | null = null;
  let resetModelOverride = false;

  if (needsModelCatalog) {
    modelCatalog = await loadModelCatalog({ config: cfg });
    const allowed = buildAllowedModelSet({
      cfg,
      catalog: modelCatalog,
      defaultProvider,
      defaultModel,
    });
    allowedModelCatalog = allowed.allowedCatalog;
    allowedModelKeys = allowed.allowedKeys;
  }

  if (sessionEntry && sessionStore && sessionKey && hasStoredOverride) {
    const overrideProvider =
      sessionEntry.providerOverride?.trim() || defaultProvider;
    const overrideModel = sessionEntry.modelOverride?.trim();
    if (overrideModel) {
      const key = modelKey(overrideProvider, overrideModel);
      if (allowedModelKeys.size > 0 && !allowedModelKeys.has(key)) {
        delete sessionEntry.providerOverride;
        delete sessionEntry.modelOverride;
        sessionEntry.updatedAt = Date.now();
        sessionStore[sessionKey] = sessionEntry;
        if (storePath) {
          await saveSessionStore(storePath, sessionStore);
        }
        resetModelOverride = true;
      }
    }
  }

  const storedProviderOverride = sessionEntry?.providerOverride?.trim();
  const storedModelOverride = sessionEntry?.modelOverride?.trim();
  if (storedModelOverride) {
    const candidateProvider = storedProviderOverride || defaultProvider;
    const key = modelKey(candidateProvider, storedModelOverride);
    if (allowedModelKeys.size === 0 || allowedModelKeys.has(key)) {
      provider = candidateProvider;
      model = storedModelOverride;
    }
  }

  if (
    sessionEntry &&
    sessionStore &&
    sessionKey &&
    sessionEntry.authProfileOverride
  ) {
    const { ensureAuthProfileStore } = await import(
      "../../agents/auth-profiles.js"
    );
    const store = ensureAuthProfileStore(undefined, {
      allowKeychainPrompt: false,
    });
    const profile = store.profiles[sessionEntry.authProfileOverride];
    if (!profile || profile.provider !== provider) {
      delete sessionEntry.authProfileOverride;
      sessionEntry.updatedAt = Date.now();
      sessionStore[sessionKey] = sessionEntry;
      if (storePath) {
        await saveSessionStore(storePath, sessionStore);
      }
    }
  }

  let defaultThinkingLevel: ThinkLevel | undefined;
  const resolveDefaultThinkingLevel = async () => {
    if (defaultThinkingLevel) return defaultThinkingLevel;
    let catalogForThinking = modelCatalog ?? allowedModelCatalog;
    if (!catalogForThinking || catalogForThinking.length === 0) {
      modelCatalog = await loadModelCatalog({ config: cfg });
      catalogForThinking = modelCatalog;
    }
    defaultThinkingLevel = resolveThinkingDefault({
      cfg,
      provider,
      model,
      catalog: catalogForThinking,
    });
    return defaultThinkingLevel;
  };

  return {
    provider,
    model,
    allowedModelKeys,
    allowedModelCatalog,
    resetModelOverride,
    resolveDefaultThinkingLevel,
    needsModelCatalog,
  };
}

export function resolveModelDirectiveSelection(params: {
  raw: string;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  allowedModelKeys: Set<string>;
}): { selection?: ModelDirectiveSelection; error?: string } {
  const { raw, defaultProvider, defaultModel, aliasIndex, allowedModelKeys } =
    params;

  const rawTrimmed = raw.trim();
  const rawLower = rawTrimmed.toLowerCase();

  const pickAliasForKey = (
    provider: string,
    model: string,
  ): string | undefined => aliasIndex.byKey.get(modelKey(provider, model))?.[0];

  const buildSelection = (
    provider: string,
    model: string,
  ): ModelDirectiveSelection => {
    const alias = pickAliasForKey(provider, model);
    return {
      provider,
      model,
      isDefault: provider === defaultProvider && model === defaultModel,
      ...(alias ? { alias } : undefined),
    };
  };

  const resolveFuzzy = (params: {
    provider?: string;
    fragment: string;
  }): { selection?: ModelDirectiveSelection; error?: string } => {
    const fragment = params.fragment.trim().toLowerCase();
    if (!fragment) return {};

    const candidates: Array<{ provider: string; model: string }> = [];
    for (const key of allowedModelKeys) {
      const slash = key.indexOf("/");
      if (slash <= 0) continue;
      const provider = normalizeProviderId(key.slice(0, slash));
      const model = key.slice(slash + 1);
      if (params.provider && provider !== normalizeProviderId(params.provider))
        continue;
      const haystack = `${provider}/${model}`.toLowerCase();
      if (
        haystack.includes(fragment) ||
        model.toLowerCase().includes(fragment)
      ) {
        candidates.push({ provider, model });
      }
    }

    // Also allow partial alias matches when the user didn't specify a provider.
    if (!params.provider) {
      const aliasMatches: Array<{ provider: string; model: string }> = [];
      for (const [aliasKey, entry] of aliasIndex.byAlias.entries()) {
        if (!aliasKey.includes(fragment)) continue;
        aliasMatches.push({
          provider: entry.ref.provider,
          model: entry.ref.model,
        });
      }
      for (const match of aliasMatches) {
        const key = modelKey(match.provider, match.model);
        if (!allowedModelKeys.has(key)) continue;
        if (
          !candidates.some(
            (c) => c.provider === match.provider && c.model === match.model,
          )
        ) {
          candidates.push(match);
        }
      }
    }

    if (candidates.length === 1) {
      const match = candidates[0];
      if (!match) return {};
      return { selection: buildSelection(match.provider, match.model) };
    }
    if (candidates.length > 1) {
      const shown = candidates
        .slice(0, 5)
        .map((c) => `${c.provider}/${c.model}`)
        .join(", ");
      const more =
        candidates.length > 5 ? ` (+${candidates.length - 5} more)` : "";
      return {
        error: `Ambiguous model "${rawTrimmed}". Matches: ${shown}${more}. Use /model to list or specify provider/model.`,
      };
    }
    return {};
  };

  const resolved = resolveModelRefFromString({
    raw: rawTrimmed,
    defaultProvider,
    aliasIndex,
  });

  if (!resolved) {
    const fuzzy = resolveFuzzy({ fragment: rawTrimmed });
    if (fuzzy.selection || fuzzy.error) return fuzzy;
    return {
      error: `Unrecognized model "${rawTrimmed}". Use /model to list available models.`,
    };
  }

  const resolvedKey = modelKey(resolved.ref.provider, resolved.ref.model);
  if (allowedModelKeys.size === 0 || allowedModelKeys.has(resolvedKey)) {
    return {
      selection: {
        provider: resolved.ref.provider,
        model: resolved.ref.model,
        isDefault:
          resolved.ref.provider === defaultProvider &&
          resolved.ref.model === defaultModel,
        alias: resolved.alias,
      },
    };
  }

  // If the user specified a provider/model but the exact model isn't allowed,
  // attempt a fuzzy match within that provider.
  if (rawLower.includes("/")) {
    const slash = rawTrimmed.indexOf("/");
    const provider = normalizeProviderId(rawTrimmed.slice(0, slash).trim());
    const fragment = rawTrimmed.slice(slash + 1).trim();
    const fuzzy = resolveFuzzy({ provider, fragment });
    if (fuzzy.selection || fuzzy.error) return fuzzy;
  }

  // Otherwise, try fuzzy matching across allowlisted models.
  const fuzzy = resolveFuzzy({ fragment: rawTrimmed });
  if (fuzzy.selection || fuzzy.error) return fuzzy;

  return {
    error: `Model "${resolved.ref.provider}/${resolved.ref.model}" is not allowed. Use /model to list available models.`,
  };
}

export function resolveContextTokens(params: {
  agentCfg:
    | NonNullable<NonNullable<ClawdbotConfig["agents"]>["defaults"]>
    | undefined;
  model: string;
}): number {
  return (
    params.agentCfg?.contextTokens ??
    lookupContextTokens(params.model) ??
    DEFAULT_CONTEXT_TOKENS
  );
}
