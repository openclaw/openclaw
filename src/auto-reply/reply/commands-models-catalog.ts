import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import type { ModelAuthAvailabilityEvaluation } from "../../agents/model-auth-availability.js";
import { createModelCatalogDecisions } from "../../agents/model-catalog-decisions.js";
import {
  resolveLogicalModelCatalogEntryState,
  resolveLogicalVisibleModelCatalog,
} from "../../agents/model-catalog-visibility.js";
import { isRetiredModelPickerProvider } from "../../agents/model-runtime-aliases.js";
import {
  dedupeModelCatalogEntries,
  resolveConfiguredModelPrimaryValue,
} from "../../agents/model-selection-shared.js";
import { normalizeProviderId, resolveDefaultModelForAgent } from "../../agents/model-selection.js";
import {
  createModelVisibilityPolicy,
  RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
} from "../../agents/model-visibility-policy.js";
import {
  openAIModelCatalogRoutePolicy,
  resolveModelCatalogIdentityKey,
} from "../../agents/openai-model-routes.js";
import { getPreparedModelRuntimeAuthStore } from "../../agents/prepared-model-runtime-auth.js";
import { PreparedModelRuntimePublicationSupersededError } from "../../agents/prepared-model-runtime.errors.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.types.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveProviderChannelLoginChoice } from "../../plugins/provider-login-options.js";
import { formatProviderLoginCommand } from "../../shared/provider-login-command.js";
import { resolveAgentRuntimeLabel } from "../../status/agent-runtime-label.js";
import type {
  ModelsBrowseOptions,
  ModelsProviderData,
  ModelsProviderMenu,
  ModelsRuntimeChoice,
  PreparedModelsProviderData,
} from "./commands-models.types.js";

const CUSTOM_MODEL_SETUP_GUIDANCE =
  "Set up this connection with the custom-provider guide: https://docs.openclaw.ai/concepts/model-providers/custom-providers";

type ModelReadiness = Pick<ModelAuthAvailabilityEvaluation, "availability" | "unavailableReason">;
type ConfiguredModelReadiness = ModelReadiness & { provider: string; model: string };

function isModelsBrowseVisibleProvider(provider: string): boolean {
  return !isRetiredModelPickerProvider(provider);
}

function normalizeRuntimeChoiceId(runtime: string | undefined): string {
  const normalized = normalizeLowercaseStringOrEmpty(runtime);
  if (!normalized || normalized === "auto" || normalized === "default") {
    return "openclaw";
  }
  return normalized;
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

export async function projectPreparedModelsProviderData(
  cfg: OpenClawConfig,
  agentId: string | undefined,
  options: ModelsBrowseOptions,
  owner: PreparedModelRuntimeSnapshot,
): Promise<PreparedModelsProviderData> {
  const runtimeNormalization = {
    ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
    manifestPlugins: owner.metadataSnapshot,
  };
  const resolvedDefault = resolveDefaultModelForAgent({
    cfg,
    agentId,
    sessionKey: options.sessionKey,
    ...runtimeNormalization,
  });
  const workspaceDir =
    options.workspaceDir ??
    (agentId ? resolveAgentWorkspaceDir(cfg, agentId) : undefined) ??
    resolveDefaultAgentWorkspaceDir();
  const snapshot = owner.modelCatalog;
  const authStore = getPreparedModelRuntimeAuthStore(owner);
  const catalog = snapshot.entries;
  const visibilityPolicy = createModelVisibilityPolicy({
    cfg,
    sessionKey: options.sessionKey,
    catalog,
    modelCatalog: snapshot,
    defaultProvider: resolvedDefault.provider,
    defaultModel: resolvedDefault.model,
    agentId,
    ...runtimeNormalization,
  });
  const effectiveDefault = visibilityPolicy.effectiveDefault.ref;
  if (!authStore) {
    throw new Error("Model catalog owner omitted its auth store");
  }
  const decisions = createModelCatalogDecisions({
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
  });
  const modelAvailability = new Map<string, ModelReadiness>();
  const { entries: visibleCatalog, allowList } = await resolveLogicalVisibleModelCatalog({
    cfg,
    catalog,
    defaultProvider: resolvedDefault.provider,
    defaultModel: resolvedDefault.model,
    agentId,
    workspaceDir,
    view: options.view,
    selectedModel: options.sessionEntry
      ? resolveSessionModelRef(cfg, options.sessionEntry, agentId, {
          allowPluginNormalization: false,
          sessionKey: options.sessionKey,
        })
      : undefined,
    policy: visibilityPolicy,
    routePolicy: openAIModelCatalogRoutePolicy,
    routeVariants: snapshot.routeVariants,
    evaluateEntry: async (entry, routeVariants) => {
      const evaluation = decisions.evaluateNative(
        entry,
        await decisions.evaluateEntry(entry, routeVariants),
      );
      modelAvailability.set(`${normalizeProviderId(entry.provider)}/${entry.id}`, {
        availability: evaluation.availability,
        unavailableReason: evaluation.unavailableReason,
      });
      return resolveLogicalModelCatalogEntryState({
        evaluation,
        provider: entry.provider,
        routePolicy: openAIModelCatalogRoutePolicy,
      });
    },
  });

  const byProvider = new Map<string, Set<string>>();
  for (const entry of visibleCatalog) {
    if (!isModelsBrowseVisibleProvider(entry.provider)) {
      continue;
    }
    const models = byProvider.get(entry.provider) ?? new Set<string>();
    models.add(entry.id);
    byProvider.set(entry.provider, models);
  }
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

  let configuredModelReadiness: ConfiguredModelReadiness | undefined;
  if (
    resolveConfiguredModelPrimaryValue({ cfg, agentId, sessionKey: options.sessionKey }) &&
    isModelsBrowseVisibleProvider(resolvedDefault.provider) &&
    !catalog.some(
      (entry) =>
        normalizeProviderId(entry.provider) === resolvedDefault.provider &&
        entry.id === resolvedDefault.model,
    )
  ) {
    // A configured ref can need sign-in without being a known or selectable model.
    const evaluation = await decisions.evaluateEntry({
      provider: resolvedDefault.provider,
      id: resolvedDefault.model,
    });
    if (evaluation.availability !== true) {
      configuredModelReadiness = {
        ...resolvedDefault,
        availability: evaluation.availability,
        unavailableReason: evaluation.unavailableReason,
      };
      if (!byProvider.has(resolvedDefault.provider)) {
        byProvider.set(resolvedDefault.provider, new Set());
      }
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
    const key = `${normalizeProviderId(entry.provider)}/${entry.id}`;
    if (effectiveDefault && key === `${effectiveDefault.provider}/${effectiveDefault.model}`) {
      modelNames.set(key, `${entry.name} (Default)`);
    } else if (entry.name && entry.name !== entry.id) {
      modelNames.set(key, entry.name);
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
      const variants = snapshot.routeVariants.filter(
        (row) => resolveModelCatalogIdentityKey(row) === resolveModelCatalogIdentityKey(authEntry),
      );
      if (!modelAvailability.has(`${provider}/${model}`)) {
        const evaluation = decisions.evaluateNative(
          authEntry,
          await decisions.evaluateEntry(authEntry, variants.length ? variants : [authEntry]),
        );
        modelAvailability.set(`${provider}/${model}`, {
          availability: evaluation.availability,
          unavailableReason: evaluation.unavailableReason,
        });
      }
      if (!entry) {
        continue;
      }
      const runtimes = await decisions.runtimeChoices(entry, variants.length ? variants : [entry]);
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
    ...(allowList ? { allowList } : {}),
    resolvedDefault,
    effectiveDefault,
    modelNames,
    modelMenu: buildModelsMenu({
      byProvider,
      modelNames,
      modelAvailability,
      loginProviders,
      configuredModelReadiness,
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

function buildModelsMenu(data: {
  byProvider: ReadonlyMap<string, ReadonlySet<string>>;
  modelNames: ReadonlyMap<string, string>;
  modelAvailability: ReadonlyMap<string, ModelReadiness>;
  loginProviders: ReadonlySet<string>;
  configuredModelReadiness?: ConfiguredModelReadiness;
}): NonNullable<ModelsProviderData["modelMenu"]> {
  const modelNames = new Map(data.modelNames);
  const byProvider = new Map<string, ModelsProviderMenu>();
  for (const [id, models] of data.byProvider) {
    const notices = new Set<string>();
    let available = 0;
    const loginSupported = data.loginProviders.has(id);
    const loginCommand = formatProviderLoginCommand(id);
    const readiness = new Map<string, ModelReadiness>(
      [...models].map((model) => [model, data.modelAvailability.get(`${id}/${model}`)!]),
    );
    if (data.configuredModelReadiness?.provider === id) {
      readiness.set(data.configuredModelReadiness.model, data.configuredModelReadiness);
    }
    for (const [model, state] of readiness) {
      const key = `${id}/${model}`;
      if (state.availability === true) {
        available += 1;
        continue;
      }
      let label: string;
      let recovery: string;
      switch (state.unavailableReason) {
        case "missing-auth":
          label = "Sign-in needed";
          recovery = loginSupported ? `Connect with ${loginCommand}.` : CUSTOM_MODEL_SETUP_GUIDANCE;
          break;
        case "auth-failed":
          label = "Sign-in failed";
          recovery = loginSupported
            ? `Sign in again with ${loginCommand}.`
            : CUSTOM_MODEL_SETUP_GUIDANCE;
          break;
        case "cooldown":
          label = "Temporarily unavailable";
          recovery = "Try again later or choose another model.";
          break;
        default:
          label = state.availability === false ? "Unavailable" : "Connection not confirmed";
          recovery =
            state.availability === false
              ? "Run /models again or choose another model."
              : loginSupported
                ? `Connect with ${loginCommand}, or choose another model.`
                : CUSTOM_MODEL_SETUP_GUIDANCE;
      }
      if (models.has(model)) {
        modelNames.set(key, `${label} — ${data.modelNames.get(key) ?? model}`);
      } else {
        notices.add(`Configured model: ${label} — ${model}.`);
      }
      notices.add(`${id}: ${label}. ${recovery}`);
    }
    byProvider.set(id, { available, notice: [...notices].join("\n") });
  }
  return { modelNames, byProvider };
}
