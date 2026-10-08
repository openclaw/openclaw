import { asPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  resolveAuthoredModelContextTokens,
  resolveModelContextTokenProjectionFromCache,
  type ContextTokenResolutionParams,
} from "../agents/context-resolution.js";
import { resolveModelContextTokenProjection } from "../agents/context.js";
import { findModelInCatalog } from "../agents/model-catalog-lookup.js";
import { resolveModelContextWindowProfile } from "../agents/model-context-window.js";
import { resolveProjectedSessionContextTokens } from "../config/sessions/context-token-provenance.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { StatusArgs } from "./status-message.types.js";

export function resolveStatusContextCapacity(params: {
  args: StatusArgs;
  contextConfig: OpenClawConfig;
  contextLookupProvider: string | undefined;
  contextLookupModel: string;
  activeModelProvider: string | undefined;
}) {
  const { args, contextConfig, contextLookupProvider, contextLookupModel, activeModelProvider } =
    params;
  const { modelRefs, sessionEntry: entry } = args;
  const selectedLookupProvider = modelRefs.selected.provider;
  const selectedLookupModel = modelRefs.selected.model;
  const projectContext = (input: ContextTokenResolutionParams) => {
    const hasPublishedLimit =
      asPositiveFiniteNumber(input.modelContextTokens) !== undefined ||
      (input.modelContextWindowSource !== "synthetic" &&
        asPositiveFiniteNumber(input.modelContextWindow) !== undefined);
    // Bound display facts supersede the passive cache; runtime budgeting keeps its cache policy.
    return input.provider?.trim() && input.model?.trim() && hasPublishedLimit
      ? resolveModelContextTokenProjectionFromCache(
          input,
          () => undefined,
          () => undefined,
        )
      : resolveModelContextTokenProjection(input);
  };
  const catalog = (args.thinkingCatalog ?? []).filter((candidate) =>
    args.resolvedHarness && args.resolvedHarness !== "openclaw"
      ? candidate.nativeRuntime === args.resolvedHarness
      : !candidate.nativeRuntime,
  );
  const selectedCatalogEntry = selectedLookupProvider
    ? findModelInCatalog(catalog, selectedLookupProvider, selectedLookupModel)
    : undefined;
  const selectedProfile = resolveModelContextWindowProfile({
    catalogEntry: selectedCatalogEntry,
    selected: entry?.contextWindow,
  });
  const selectedContextProjection = projectContext({
    cfg: contextConfig,
    provider: selectedLookupProvider,
    model: selectedLookupModel,
    nativeRuntime: args.resolvedHarness,
    modelContextWindow: selectedProfile.contextWindow
      ? selectedProfile.contextTokens
      : (args.selectedContextWindow ?? selectedProfile.contextTokens),
    modelContextWindowSource: selectedProfile.contextWindow
      ? undefined
      : args.selectedContextWindow !== undefined
        ? args.selectedContextWindowSource
        : selectedCatalogEntry?.contextWindowSource,
    modelContextTokens: args.selectedContextTokens ?? selectedCatalogEntry?.contextTokens,
    allowAsyncLoad: false,
  });
  const activeCatalogEntry = contextLookupProvider
    ? findModelInCatalog(catalog, contextLookupProvider, contextLookupModel)
    : undefined;
  const activeProfile = resolveModelContextWindowProfile({
    catalogEntry: activeCatalogEntry,
    selected: entry?.contextWindow,
  });
  const activeModelMatchesPreparedIdentity =
    normalizeLowercaseStringOrEmpty(contextLookupProvider) ===
      normalizeLowercaseStringOrEmpty(modelRefs.active.provider) &&
    normalizeLowercaseStringOrEmpty(contextLookupModel) ===
      normalizeLowercaseStringOrEmpty(modelRefs.active.model);
  const activeContextProvider =
    contextLookupProvider &&
    normalizeLowercaseStringOrEmpty(contextLookupProvider) ===
      normalizeLowercaseStringOrEmpty(modelRefs.active.provider)
      ? (args.runtimeContextProvider ?? contextLookupProvider)
      : contextLookupProvider;
  const activeContextProjection = projectContext({
    cfg: contextConfig,
    ...(activeContextProvider ? { provider: activeContextProvider } : {}),
    modelProvider: contextLookupProvider,
    model: contextLookupModel,
    nativeRuntime: args.resolvedHarness,
    modelContextWindow: activeProfile.contextTokens,
    modelContextWindowSource: activeProfile.contextWindow
      ? undefined
      : activeCatalogEntry?.contextWindowSource,
    modelContextTokens:
      activeCatalogEntry?.contextTokens ??
      ((activeCatalogEntry || activeModelMatchesPreparedIdentity) &&
      activeCatalogEntry?.contextWindowSource !== "synthetic"
        ? args.runtimeContextTokens
        : undefined),
    allowAsyncLoad: false,
  });
  const projectedActiveContextTokens = resolveProjectedSessionContextTokens({
    entry,
    provider: contextLookupProvider,
    model: contextLookupModel,
    agentHarnessId: args.resolvedHarness,
    resolvedContextTokens:
      activeContextProjection.source === "fallback"
        ? undefined
        : activeContextProjection.contextTokens,
    authoredContextTokens: resolveAuthoredModelContextTokens({
      cfg: contextConfig,
      provider: contextLookupProvider,
      modelProvider: activeModelProvider,
      model: contextLookupModel,
      nativeRuntime: args.resolvedHarness,
    }),
    ownerCapacity: args.resolveOwnerContextCapacity?.(contextLookupProvider, contextLookupModel),
  });
  const selectedOptionTokens = selectedProfile.contextWindow
    ? asPositiveFiniteNumber(selectedProfile.contextTokens)
    : undefined;
  const activeOptionTokens = activeProfile.contextWindow
    ? asPositiveFiniteNumber(activeProfile.contextTokens)
    : undefined;
  return {
    selectedContextTokens:
      selectedContextProjection.contextTokens !== undefined && selectedOptionTokens !== undefined
        ? Math.min(selectedContextProjection.contextTokens, selectedOptionTokens)
        : selectedContextProjection.contextTokens,
    projectedActiveContextTokens:
      projectedActiveContextTokens !== undefined && activeOptionTokens !== undefined
        ? Math.min(projectedActiveContextTokens, activeOptionTokens)
        : projectedActiveContextTokens,
  };
}
