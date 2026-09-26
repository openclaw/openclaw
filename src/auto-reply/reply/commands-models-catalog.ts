import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { listCliRuntimeModelBackendBindings } from "../../agents/cli-backends.js";
import {
  createModelCatalogDecisions,
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
import { PreparedModelRuntimePublicationSupersededError } from "../../agents/prepared-model-runtime.errors.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.types.js";
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

function isModelsBrowseVisibleProvider(provider: string): boolean {
  return !isRetiredModelPickerProvider(provider);
}

function buildRuntimeChoice(params: { cfg: OpenClawConfig; runtime: string }): ModelsRuntimeChoice {
  const id = normalizeRuntimeChoiceId(params.runtime);
  const label = resolveAgentRuntimeLabel({ config: params.cfg, resolvedHarness: id });
  return {
    id,
    label,
    description:
      id === "openclaw"
        ? "Use OpenClaw's built-in agent and tools."
        : `Use ${label} to run this model.`,
  };
}

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
  cfg: OpenClawConfig,
  agentId: string | undefined,
  options: ModelsBrowseOptions,
  agentDir?: string,
): Promise<PreparedModelsProviderData> {
  const published = await preparedModelCatalog.loadPublishedPreparedModelCatalogOwnerSnapshot({
    config: cfg,
    ...(agentId ? { agentId } : {}),
    ...(agentDir ? { agentDir } : {}),
    ...(options.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
    readOnly: true,
  });
  // The owner records refresh outcomes; a sent menu must not wait for acquisition or be rewritten.
  void published.loadFullModelCatalog?.().catch(() => undefined);
  return projectPreparedModelsProviderData(published.config, agentId, options, published);
}

async function projectPreparedModelsProviderData(
  cfg: OpenClawConfig,
  agentId: string | undefined,
  options: ModelsBrowseOptions,
  owner: PreparedModelRuntimeSnapshot,
): Promise<PreparedModelsProviderData> {
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
  const decisions = createModelCatalogDecisions(decisionParams);
  // Selecting the default clears the session runtime pin; other model callbacks retain it.
  const defaultDecisions =
    decisionParams.runtimeOverride && resolveModelRuntimeRoute(resolvedDefault.provider)
      ? createModelCatalogDecisions({ ...decisionParams, runtimeOverride: undefined })
      : decisions;
  const decisionsForEntry = (entry: Pick<ModelCatalogEntry, "provider" | "id">) =>
    normalizeProviderId(entry.provider) === resolvedDefault.provider &&
    entry.id === resolvedDefault.model
      ? defaultDecisions
      : decisions;
  // Configured/default rows may remain visible without auth, but must not
  // reintroduce a model that its provider route contract rejected.
  const incompatibleModelKeys = new Set<string>();
  const modelAvailability = new Map<string, ModelReadiness>();
  const hasAuth: ModelCatalogAuthChecker =
    options.view === "all"
      ? async () => true
      : async (provider, ref) => {
          const entry = catalog.find((row) => row.provider === provider && row.id === ref?.modelId);
          if (!entry) {
            return false;
          }
          const selectionDecisions = decisionsForEntry(entry);
          return (
            selectionDecisions.evaluateNative(entry, await selectionDecisions.evaluateEntry(entry))
              .availability === true
          );
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
      const selectionDecisions = decisionsForEntry(entry);
      const evaluation = selectionDecisions.evaluateNative(
        entry,
        await selectionDecisions.evaluateEntry(entry, routeVariants),
      );
      modelAvailability.set(`${normalizeProviderId(entry.provider)}/${entry.id}`, {
        availability: evaluation.availability,
        unavailableReason: evaluation.unavailableReason,
        runtimeAuth: evaluation.runtimeAuth,
        runtimeId: resolveModelRuntimeRoute(entry.provider)
          ? resolveCatalogDecisionRuntime({
              cfg,
              agentId: owner.agentId ?? agentId ?? "main",
              entry,
              evaluation,
              pluginRegistry: owner.pluginRegistry,
            })?.id
          : undefined,
      });
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
    if (!isModelsBrowseVisibleProvider(key)) {
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

  const addModelConfigEntries = () => {
    const modelConfig = cfg.agents?.defaults?.model;
    if (typeof modelConfig === "string") {
      addRawModelRef(modelConfig);
    } else if (modelConfig && typeof modelConfig === "object") {
      addRawModelRef(modelConfig.primary);
      for (const fallback of modelConfig.fallbacks ?? []) {
        addRawModelRef(fallback);
      }
    }

    const imageConfig = cfg.agents?.defaults?.imageModel;
    if (typeof imageConfig === "string") {
      addRawModelRef(imageConfig);
    } else if (imageConfig && typeof imageConfig === "object") {
      addRawModelRef(imageConfig.primary);
      for (const fallback of imageConfig.fallbacks ?? []) {
        addRawModelRef(fallback);
      }
    }
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
  addModelConfigEntries();

  const pendingProviders = decisions.snapshot.pendingProviders?.filter(
    (provider) =>
      isModelsBrowseVisibleProvider(provider) &&
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

  const runtimeChoicesByProvider = new Map<string, ModelsRuntimeChoice[]>();
  const runtimeChoicesByModel = new Map<string, ModelsRuntimeChoice[]>();
  for (const [provider, models] of byProvider) {
    const providerChoices = new Map<string, ModelsRuntimeChoice>();
    for (const model of models) {
      const entry = [...visibleCatalog, ...catalog].find(
        (row) => normalizeProviderId(row.provider) === provider && row.id === model,
      );
      const authEntry = entry ?? { provider, id: model, name: model };
      const selectionDecisions = decisionsForEntry(authEntry);
      const variants = snapshot.routeVariants.filter(
        (row) => resolveModelCatalogIdentityKey(row) === resolveModelCatalogIdentityKey(authEntry),
      );
      if (!modelAvailability.has(`${provider}/${model}`)) {
        const evaluation = selectionDecisions.evaluateNative(
          authEntry,
          await selectionDecisions.evaluateEntry(
            authEntry,
            variants.length ? variants : [authEntry],
          ),
        );
        modelAvailability.set(`${provider}/${model}`, {
          availability: evaluation.availability,
          unavailableReason: evaluation.unavailableReason,
          runtimeAuth: evaluation.runtimeAuth,
          runtimeId: resolveModelRuntimeRoute(provider)
            ? resolveCatalogDecisionRuntime({
                cfg,
                agentId: owner.agentId ?? agentId ?? "main",
                entry: authEntry,
                evaluation,
                pluginRegistry: owner.pluginRegistry,
              })?.id
            : undefined,
        });
      }
      if (!entry) {
        continue;
      }
      const runtimes = await selectionDecisions.runtimeChoices(
        entry,
        variants.length ? variants : [entry],
      );
      if (!runtimes) {
        continue;
      }
      const choices = runtimes.map((runtime) => buildRuntimeChoice({ cfg, runtime }));
      runtimeChoicesByModel.set(`${provider}/${model}`, choices);
      for (const choice of choices) {
        providerChoices.set(choice.id, choice);
      }
    }
    runtimeChoicesByProvider.set(provider, [...providerChoices.values()]);
  }

  // Auth and visibility cross awaits. Retired owners must restart the whole projection.
  if (!owner.isCurrent()) {
    throw new PreparedModelRuntimePublicationSupersededError("model browse owner was superseded");
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
    // Selection needs the prepared capabilities, with selected physical routes
    // ahead of other inventory rows for the same logical model.
    modelCatalog: dedupeModelCatalogEntries([...visibleCatalog, ...catalog]),
    runtimeChoicesByProvider,
    runtimeChoicesByModel,
    isCurrent: decisions.isCurrent,
  };
}
