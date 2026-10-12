import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { listCliRuntimeModelBackendBindings } from "../../agents/cli-backends.js";
import {
  createModelCatalogDecisions,
  prepareModelCatalogDecisions,
  resolveCatalogDecisionRuntime,
} from "../../agents/model-catalog-decisions.js";
import {
  resolveLogicalModelCatalogEntryState,
  resolveLogicalVisibleModelCatalog,
  type ModelCatalogAuthChecker,
} from "../../agents/model-catalog-visibility.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { isRetiredModelPickerProvider } from "../../agents/model-runtime-aliases.js";
import {
  dedupeModelCatalogEntries,
  LEGACY_MODEL_POLICY_ALLOW_CONFIG_PATH,
} from "../../agents/model-selection-shared.js";
import {
  buildModelAliasIndex,
  normalizeProviderId,
  resolveBareModelDefaultProvider,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import { createModelVisibilityPolicy } from "../../agents/model-visibility-policy.js";
import {
  openAIModelCatalogRoutePolicy,
  resolveModelCatalogIdentityKey,
} from "../../agents/openai-model-routes.js";
import * as preparedModelCatalog from "../../agents/prepared-model-catalog.js";
import { getPreparedModelRuntimeAuthStore } from "../../agents/prepared-model-runtime-auth.js";
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveProviderChannelLoginChoice } from "../../plugins/provider-login-options.js";
import { resolveModelRuntimeRoute } from "../../shared/model-runtime-route.js";
import { resolveAgentRuntimeLabel } from "../../status/agent-runtime-label.js";
import { buildModelsMenu, type ModelReadiness, type ModelsMenu } from "./commands-models-menu.js";
import {
  normalizeRuntimeChoiceId,
  resolveRuntimeNormalization,
} from "./model-runtime-normalization.js";

export type ModelsCommandSessionEntry = Partial<
  Pick<
    SessionEntry,
    | "authProfileOverride"
    | "authProfileOverrideSource"
    | "modelProvider"
    | "providerOverride"
    | "model"
    | "modelSelectionLocked"
    | "agentRuntimeOverride"
  >
>;

export type ModelsProviderData = {
  byProvider: Map<string, Set<string>>;
  pendingProviders?: readonly string[];
  providers: string[];
  resolvedDefault: { provider: string; model: string };
  modelNames: Map<string, string>;
  modelMenu?: ModelsMenu;
  refreshWarning?: string;
  runtimeChoicesByProvider?: Map<string, ModelsRuntimeChoice[]>;
  runtimeChoicesByModel?: Map<string, ModelsRuntimeChoice[]>;
  /**
   * Configured default runtime per provider/model, for models that offer more
   * than one runtime. Resolved from config and the current auth route for any
   * provider, without the session's runtime pin, so it names the runtime the
   * model uses when no override is set.
   */
  modelRuntimeIds?: Map<string, string>;
  isCurrent?: () => boolean;
};

export type PreparedModelsProviderData = ModelsProviderData & {
  modelCatalog: ModelCatalogEntry[];
};

type ModelsBrowseOptions = {
  view?: "default" | "all";
  workspaceDir?: string;
  sessionEntry?: ModelsCommandSessionEntry;
};

export type ModelsRuntimeChoice = {
  id: string;
  label: string;
  description: string;
};

/** Undefined is unknown; an empty list is an authoritative refusal. */
export function getModelsRuntimeChoices(
  data: ModelsProviderData,
  provider: string,
  model?: string,
): ModelsRuntimeChoice[] | undefined {
  if (data.isCurrent?.() === false) {
    return undefined;
  }
  return model
    ? data.runtimeChoicesByModel?.get(`${normalizeProviderId(provider)}/${model}`)
    : data.runtimeChoicesByProvider?.get(normalizeProviderId(provider));
}

export function buildPreparedModelsProviderData(
  cfg: OpenClawConfig,
  agentId?: string,
  options: ModelsBrowseOptions = {},
): Promise<PreparedModelsProviderData> {
  return loadModelsProviderData(cfg, agentId, options);
}

export async function loadModelsProviderData(
  config: OpenClawConfig,
  agentId: string | undefined,
  options: ModelsBrowseOptions,
  agentDir?: string,
): Promise<PreparedModelsProviderData> {
  const owner = await preparedModelCatalog.loadPublishedPreparedModelCatalogOwnerSnapshot({
    config,
    ...(agentId ? { agentId } : {}),
    ...(agentDir ? { agentDir } : {}),
    ...(options.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
    readOnly: true,
  });
  // The owner records refresh outcomes; a sent menu must not wait for acquisition or be rewritten.
  void owner.loadFullModelCatalog?.().catch(() => undefined);
  const cfg = owner.config;
  const runtimeNormalization = resolveRuntimeNormalization(cfg);
  const resolvedDefault = resolveDefaultModelForAgent({
    cfg,
    agentId,
    ...runtimeNormalization,
  });
  const workspaceDir =
    options.workspaceDir ??
    (agentId ? resolveAgentWorkspaceDir(cfg, agentId) : undefined) ??
    resolveDefaultAgentWorkspaceDir();
  const cliRuntimeProviders = new Set(
    listCliRuntimeModelBackendBindings().map((binding) => normalizeProviderId(binding.runtime)),
  );
  const snapshot = owner.modelCatalog;
  const authStore = getPreparedModelRuntimeAuthStore(owner);
  const catalog = snapshot.entries;
  const visibilityPolicy = createModelVisibilityPolicy({
    cfg,
    catalog,
    defaultProvider: resolvedDefault.provider,
    defaultModel: resolvedDefault,
    agentId,
    ...runtimeNormalization,
  });
  if (!authStore) {
    throw new Error("Model catalog owner omitted its auth store");
  }
  const decisionParams = {
    cfg,
    agentId: owner.agentId ?? agentId ?? "main",
    agentDir: owner.agentDir,
    workspaceDir,
    snapshot,
    metadataSnapshot: owner.metadataSnapshot,
    preparedAuthStore: authStore,
    preparedRuntimeAuthModes: owner.authModes,
    pluginRegistry: owner.pluginRegistry,
    observationConfig: owner.observationConfig,
    isCurrent: owner.isCurrent,
    preferredProfileId: options.sessionEntry?.authProfileOverride,
    pinnedProfileId:
      options.sessionEntry?.authProfileOverrideSource === "user"
        ? options.sessionEntry.authProfileOverride
        : undefined,
    profileProvider: options.sessionEntry?.providerOverride ?? options.sessionEntry?.modelProvider,
    runtimeOverride: options.sessionEntry?.agentRuntimeOverride,
  };
  const decisions = await prepareModelCatalogDecisions(decisionParams);
  // Configured runtimes ignore the session's runtime pin.
  const configuredDecisions = decisionParams.runtimeOverride
    ? createModelCatalogDecisions({
        ...decisionParams,
        preparedPersonalCatalog: decisions.preparedPersonalCatalog,
        runtimeOverride: undefined,
      })
    : decisions;
  // Selecting the default clears the session runtime pin; other model callbacks retain it.
  const defaultDecisions = resolveModelRuntimeRoute(resolvedDefault.provider)
    ? configuredDecisions
    : decisions;
  const decisionsForEntry = (entry: Pick<ModelCatalogEntry, "provider" | "id">) =>
    normalizeProviderId(entry.provider) === resolvedDefault.provider &&
    entry.id === resolvedDefault.model
      ? defaultDecisions
      : decisions;
  const evaluateEntry = (entry: ModelCatalogEntry, variants?: readonly ModelCatalogEntry[]) => {
    const selection = decisionsForEntry(entry);
    return selection.evaluateNative(entry, selection.evaluateEntry(entry, variants));
  };
  // Configured/default rows may remain visible without auth, but must not
  // reintroduce a model that its provider route contract rejected.
  const incompatibleModelKeys = new Set<string>();
  const modelAvailability = new Map<string, ModelReadiness>();
  const recordModelAvailability = (
    entry: ModelCatalogEntry,
    evaluation: ReturnType<typeof decisions.evaluateNative>,
    provider = entry.provider,
  ) => {
    modelAvailability.set(`${normalizeProviderId(provider)}/${entry.id}`, {
      availability: evaluation.availability,
      unavailableReason: evaluation.unavailableReason,
      runtimeAuth: evaluation.runtimeAuth,
      runtimeId: resolveModelRuntimeRoute(provider)
        ? resolveCatalogDecisionRuntime({
            cfg,
            agentId: owner.agentId ?? agentId ?? "main",
            entry,
            evaluation,
            pluginRegistry: owner.pluginRegistry,
          })?.id
        : undefined,
    });
  };
  const hasAuth: ModelCatalogAuthChecker =
    options.view === "all"
      ? async () => true
      : async (provider, ref) => {
          const entry = catalog.find((row) => row.provider === provider && row.id === ref?.modelId);
          if (!entry) {
            return false;
          }
          return evaluateEntry(entry).availability === true;
        };
  const visibleCatalog = await resolveLogicalVisibleModelCatalog({
    cfg,
    metadataSnapshot: owner.metadataSnapshot,
    catalog,
    defaultProvider: resolvedDefault.provider,
    defaultModel: resolvedDefault,
    selectedModel: resolvedDefault,
    agentId,
    workspaceDir,
    view: options.view,
    policy: visibilityPolicy,
    routePolicy: openAIModelCatalogRoutePolicy,
    routeVariants: snapshot.routeVariants,
    evaluateEntry: async (entry, routeVariants) => {
      const evaluation = evaluateEntry(entry, routeVariants);
      recordModelAvailability(entry, evaluation);
      if (evaluation.routeResolution?.kind === "incompatible") {
        incompatibleModelKeys.add(resolveModelCatalogIdentityKey(entry));
      }
      return resolveLogicalModelCatalogEntryState({
        evaluation,
        authBacked: options.view === "all" || evaluation.availability === true,
        routePolicy: openAIModelCatalogRoutePolicy,
      });
    },
  });

  const aliasIndex = buildModelAliasIndex({
    cfg,
    defaultProvider: resolvedDefault.provider,
    agentId,
    ...runtimeNormalization,
  });
  const restrictToProviderWildcards =
    options.view !== "all" && visibilityPolicy.hasProviderWildcards;
  // Preserve legacy/unrestricted CLI browsing without widening an explicit policy.
  const useUnfilteredCliCatalog =
    options.view === "all" ||
    visibilityPolicy.allowAny ||
    visibilityPolicy.allowConfigPath === LEGACY_MODEL_POLICY_ALLOW_CONFIG_PATH;

  const byProvider = new Map<string, Set<string>>();
  const add = (p: string, m: string) => {
    const key = normalizeProviderId(p);
    if (isRetiredModelPickerProvider(key)) {
      return;
    }
    if (
      restrictToProviderWildcards &&
      !(useUnfilteredCliCatalog && cliRuntimeProviders.has(key)) &&
      !visibilityPolicy.allows({ provider: key, model: m })
    ) {
      return;
    }
    const set = byProvider.get(key) ?? new Set<string>();
    set.add(m);
    byProvider.set(key, set);
  };

  const addRawModelRef = (raw?: string) => {
    const trimmed = normalizeOptionalString(raw);
    if (!trimmed) {
      return;
    }
    const defaultProvider = !trimmed.includes("/")
      ? resolveBareModelDefaultProvider({
          cfg,
          catalog,
          model: trimmed,
          defaultProvider: resolvedDefault.provider,
          agentId,
          manifestPlugins: runtimeNormalization.manifestPlugins,
        })
      : resolvedDefault.provider;
    const resolved = resolveModelRefFromString({
      cfg,
      agentId,
      raw: trimmed,
      defaultProvider,
      aliasIndex,
      ...runtimeNormalization,
    });
    if (!resolved) {
      return;
    }
    if (
      incompatibleModelKeys.has(
        resolveModelCatalogIdentityKey({ provider: resolved.ref.provider, id: resolved.ref.model }),
      )
    ) {
      return;
    }
    add(resolved.ref.provider, resolved.ref.model);
  };

  for (const entry of visibleCatalog) {
    if (incompatibleModelKeys.has(resolveModelCatalogIdentityKey(entry))) {
      continue;
    }
    add(entry.provider, entry.id);
  }

  for (const entry of catalog) {
    if (
      useUnfilteredCliCatalog &&
      cliRuntimeProviders.has(normalizeProviderId(entry.provider)) &&
      (await hasAuth(entry.provider, {
        modelId: entry.id,
        api: entry.api,
        baseUrl: entry.baseUrl,
      }))
    ) {
      add(entry.provider, entry.id);
    }
  }

  for (const raw of visibilityPolicy.exactModelRefs) {
    addRawModelRef(raw);
  }

  if (
    !incompatibleModelKeys.has(
      resolveModelCatalogIdentityKey({
        provider: resolvedDefault.provider,
        id: resolvedDefault.model,
      }),
    )
  ) {
    add(resolvedDefault.provider, resolvedDefault.model);
  }
  for (const modelConfig of [cfg.agents?.defaults?.model, cfg.agents?.defaults?.imageModel]) {
    if (typeof modelConfig === "string") {
      addRawModelRef(modelConfig);
    } else if (modelConfig && typeof modelConfig === "object") {
      addRawModelRef(modelConfig.primary);
      for (const fallback of modelConfig.fallbacks ?? []) {
        addRawModelRef(fallback);
      }
    }
  }

  const pendingProviders = decisions.snapshot.pendingProviders?.filter(
    (provider) =>
      !isRetiredModelPickerProvider(provider) &&
      (options.view === "all" ||
        visibilityPolicy.allowAny ||
        [...visibilityPolicy.allowedKeys].some((key) => key.startsWith(`${provider}/`))),
  );
  for (const provider of pendingProviders ?? []) {
    if (!byProvider.has(provider)) {
      byProvider.set(provider, new Set());
    }
  }

  const providers = [...byProvider.keys()].toSorted();
  const loginProviders = new Set(
    providers.filter(
      (provider) =>
        resolveProviderChannelLoginChoice(provider, {
          config: cfg,
          workspaceDir,
          metadataSnapshot: owner.metadataSnapshot,
        }).status !== "unsupported",
    ),
  );

  const modelNames = new Map<string, string>();
  for (const entry of [...catalog, ...visibleCatalog]) {
    if (entry.name && entry.name !== entry.id) {
      modelNames.set(`${normalizeProviderId(entry.provider)}/${entry.id}`, entry.name);
    }
  }

  // Selection needs the prepared capabilities, with selected physical routes
  // ahead of other inventory rows for the same logical model.
  const selectionCatalog = [...visibleCatalog, ...catalog];
  const runtimeChoicesByProvider = new Map<string, ModelsRuntimeChoice[]>();
  const runtimeChoicesByModel = new Map<string, ModelsRuntimeChoice[]>();
  const modelRuntimeIds = new Map<string, string>();
  for (const [provider, models] of byProvider) {
    const providerChoices = new Map<string, ModelsRuntimeChoice>();
    for (const model of models) {
      const entry = selectionCatalog.find(
        (row) => normalizeProviderId(row.provider) === provider && row.id === model,
      );
      const authEntry = entry ?? { provider, id: model, name: model };
      const variants = snapshot.routeVariants.filter(
        (row) => resolveModelCatalogIdentityKey(row) === resolveModelCatalogIdentityKey(authEntry),
      );
      if (!modelAvailability.has(`${provider}/${model}`)) {
        const evaluation = evaluateEntry(authEntry, variants.length ? variants : [authEntry]);
        recordModelAvailability(authEntry, evaluation, provider);
      }
      if (!entry) {
        continue;
      }
      const runtimes = decisionsForEntry(entry).runtimeChoices(
        entry,
        variants.length ? variants : [entry],
      );
      if (!runtimes) {
        continue;
      }
      const choices = runtimes.map((runtime) => {
        const id = normalizeRuntimeChoiceId(runtime);
        const label = resolveAgentRuntimeLabel({ config: cfg, resolvedHarness: id });
        return {
          id,
          label,
          description:
            id === "openclaw"
              ? "Use OpenClaw's built-in agent and tools."
              : `Use ${label} to run this model.`,
        };
      });
      runtimeChoicesByModel.set(`${provider}/${model}`, choices);
      if (choices.length > 1) {
        const configuredEvaluation = configuredDecisions.evaluateNative(
          entry,
          configuredDecisions.evaluateEntry(entry, variants.length ? variants : [entry]),
        );
        const configuredRuntime = resolveCatalogDecisionRuntime({
          cfg,
          agentId: owner.agentId ?? agentId ?? "main",
          entry,
          evaluation: configuredEvaluation,
          pluginRegistry: owner.pluginRegistry,
        })?.id;
        if (configuredRuntime) {
          modelRuntimeIds.set(`${provider}/${model}`, normalizeRuntimeChoiceId(configuredRuntime));
        }
      }
      for (const choice of choices) {
        providerChoices.set(choice.id, choice);
      }
    }
    runtimeChoicesByProvider.set(provider, [...providerChoices.values()]);
  }

  return {
    byProvider,
    pendingProviders,
    providers,
    resolvedDefault,
    modelNames,
    modelMenu: buildModelsMenu({
      byProvider,
      modelNames,
      modelAvailability,
      loginProviders,
      pendingProviders,
    }),
    refreshWarning: snapshot.refreshFailed
      ? "Some models could not be refreshed. You can still choose from the available models."
      : undefined,
    modelCatalog: dedupeModelCatalogEntries(selectionCatalog),
    runtimeChoicesByProvider,
    runtimeChoicesByModel,
    modelRuntimeIds,
    isCurrent: decisions.isCurrent,
  };
}
