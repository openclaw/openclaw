// Implements model listing and provider catalog commands.
import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  resolveAgentDir,
  resolveAgentEffectiveModelPrimary,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import { listCliRuntimeModelBackendBindings } from "../../agents/cli-backends.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import { resolveModelAuthLabel } from "../../agents/model-auth-label.js";
import { createModelCatalogDecisions } from "../../agents/model-catalog-decisions.js";
import {
  resolveLogicalModelCatalogEntryState,
  resolveLogicalVisibleModelCatalog,
} from "../../agents/model-catalog-visibility.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { modelKey } from "../../agents/model-ref-shared.js";
import { dedupeModelCatalogEntries } from "../../agents/model-selection-shared.js";
import { normalizeProviderId, resolveDefaultModelForAgent } from "../../agents/model-selection.js";
import { createModelVisibilityPolicy } from "../../agents/model-visibility-policy.js";
import {
  openAIModelCatalogRoutePolicy,
  resolveModelCatalogIdentityKey,
} from "../../agents/openai-model-routes.js";
import { listOpenAIAuthProfileProvidersForAgentRuntime } from "../../agents/openai-routing.js";
import * as preparedModelCatalog from "../../agents/prepared-model-catalog.js";
import { getPreparedModelRuntimeAuthStore } from "../../agents/prepared-model-runtime-auth.js";
import {
  PreparedModelRuntimeOwnerNotPublishedError,
  PreparedModelRuntimePublicationSupersededError,
} from "../../agents/prepared-model-runtime.errors.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.types.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAgentRuntimeLabel } from "../../status/agent-runtime-label.js";
import type { ReplyPayload } from "../types.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";
import { resolveRuntimeNormalization } from "./model-runtime-normalization.js";

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;
const MODELS_ADD_DEPRECATED_TEXT =
  "⚠️ /models add is deprecated. Use /models to browse providers and /model to switch models.";

type ModelsCommandSessionEntry = Partial<
  Pick<
    SessionEntry,
    | "authProfileOverride"
    | "authProfileOverrideSource"
    | "modelProvider"
    | "providerOverride"
    | "modelOverride"
    | "modelOverrideRouteResolution"
    | "modelOverrideFallbackOriginProvider"
    | "modelOverrideFallbackOriginModel"
    | "model"
    | "modelSelectionLocked"
    | "agentRuntimeOverride"
  >
>;

export type ModelsProviderData = {
  byProvider: Map<string, Set<string>>;
  providers: string[];
  resolvedDefault: { provider: string; model: string };
  modelNames: Map<string, string>;
  runtimeChoicesByProvider?: Map<string, ModelsRuntimeChoice[]>;
  runtimeChoicesByModel?: Map<string, ModelsRuntimeChoice[]>;
  isCurrent?: () => boolean;
};

type PreparedModelsProviderData = ModelsProviderData & {
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

type ParsedModelsCommand =
  | { action: "providers" }
  | {
      action: "list";
      provider?: string;
      page: number;
      pageSize: number;
      all: boolean;
    }
  | {
      action: "add";
      provider?: string;
      modelId?: string;
    };

function normalizeRuntimeChoiceId(runtime: string | undefined): string {
  const normalized = normalizeLowercaseStringOrEmpty(runtime);
  if (!normalized || normalized === "auto" || normalized === "default") {
    return "openclaw";
  }
  return normalized;
}

function buildRuntimeChoice(params: {
  cfg: OpenClawConfig;
  provider: string;
  runtime: string;
  cli?: boolean;
}): ModelsRuntimeChoice {
  const id = normalizeRuntimeChoiceId(params.runtime);
  const label = resolveAgentRuntimeLabel({ config: params.cfg, resolvedHarness: id });
  return {
    id,
    label,
    description:
      id === "openclaw"
        ? "Use the built-in OpenClaw runtime."
        : params.cli
          ? `Run ${params.provider} models through ${label}.`
          : `Use the ${label} runtime selected by the effective harness policy.`,
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
  return buildPreparedModelsProviderDataWithContext(cfg, agentId, options);
}

async function buildPreparedModelsProviderDataWithContext(
  cfg: OpenClawConfig,
  agentId: string | undefined,
  options: ModelsBrowseOptions,
  agentDir?: string,
): Promise<PreparedModelsProviderData> {
  const owner = preparedModelCatalog.getPublishedPreparedModelCatalogOwnerSnapshot({
    config: cfg,
    ...(agentId ? { agentId } : {}),
    ...(agentDir ? { agentDir } : {}),
    ...(options.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
  });
  if (!owner) {
    throw new PreparedModelRuntimeOwnerNotPublishedError(
      "Model catalog is not ready. Retry after Gateway startup or refresh finishes.",
    );
  }
  // Browse uses the completed generation and its paired auth. Selection and turn-path
  // capability discovery remain with their own runtime owners.
  const published = preparedModelCatalog.materializePreparedModelCatalogOwner(owner);
  return projectPreparedModelsProviderData(published.config, agentId, options, published);
}

async function projectPreparedModelsProviderData(
  cfg: OpenClawConfig,
  agentId: string | undefined,
  options: ModelsBrowseOptions,
  owner: PreparedModelRuntimeSnapshot,
): Promise<PreparedModelsProviderData> {
  const selectedAgentId = owner.agentId ?? agentId ?? resolveDefaultAgentId(cfg);
  const runtimeNormalization = resolveRuntimeNormalization(cfg);
  const resolvedDefault = resolveDefaultModelForAgent({
    cfg,
    agentId: selectedAgentId,
    ...runtimeNormalization,
  });
  const workspaceDir =
    options.workspaceDir ?? owner.workspaceDir ?? resolveAgentWorkspaceDir(cfg, selectedAgentId);
  const cliRuntimeProviders = new Set(
    listCliRuntimeModelBackendBindings().map((binding) => normalizeProviderId(binding.runtime)),
  );
  const authStore = getPreparedModelRuntimeAuthStore(owner);
  const selectedModel = options.sessionEntry?.modelOverride
    ? resolveSessionModelRef(cfg, options.sessionEntry, selectedAgentId, {
        allowPluginNormalization: false,
      })
    : undefined;
  const defaultModel = selectedModel
    ? modelKey(selectedModel.provider, selectedModel.model)
    : resolveAgentEffectiveModelPrimary(cfg, selectedAgentId);
  if (!authStore) {
    throw new Error("Model catalog owner omitted its auth store");
  }
  const decisions = createModelCatalogDecisions({
    cfg,
    agentId: selectedAgentId,
    agentDir: owner.agentDir,
    workspaceDir,
    selectedModel,
    snapshot: owner.modelCatalog,
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
  const snapshot = decisions.snapshot;
  const catalog = snapshot.entries;
  const visibilityPolicy = createModelVisibilityPolicy({
    cfg,
    catalog,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel,
    agentId: selectedAgentId,
    ...runtimeNormalization,
  });
  const visibleCatalog = await resolveLogicalVisibleModelCatalog({
    cfg,
    catalog,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel,
    agentId: selectedAgentId,
    workspaceDir,
    view: options.view,
    policy: visibilityPolicy,
    routePolicy: openAIModelCatalogRoutePolicy,
    routeVariants: snapshot.routeVariants,
    evaluateEntry: async (entry, routeVariants) => {
      const evaluation = decisions.evaluateNative(
        entry,
        await decisions.evaluateEntry(entry, routeVariants),
      );
      return resolveLogicalModelCatalogEntryState({
        evaluation,
        authBacked: options.view === "all" || evaluation.availability === true,
        routePolicy: openAIModelCatalogRoutePolicy,
      });
    },
  });

  const byProvider = new Map<string, Set<string>>();
  for (const entry of visibleCatalog) {
    const provider = normalizeProviderId(entry.provider);
    const models = byProvider.get(provider) ?? new Set<string>();
    models.add(entry.id);
    byProvider.set(provider, models);
  }

  const providers = [...byProvider.keys()].toSorted();

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
      if (!entry) {
        continue;
      }
      const variants = snapshot.routeVariants.filter(
        (row) => resolveModelCatalogIdentityKey(row) === resolveModelCatalogIdentityKey(entry),
      );
      const runtimes = await decisions.runtimeChoices(entry, variants.length ? variants : [entry]);
      if (!runtimes) {
        continue;
      }
      const choices = runtimes.map((runtime) =>
        buildRuntimeChoice({ cfg, provider, runtime, cli: cliRuntimeProviders.has(runtime) }),
      );
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
    providers,
    resolvedDefault,
    modelNames,
    // Selection needs the prepared capabilities, with selected physical routes
    // ahead of other inventory rows for the same logical model.
    modelCatalog: dedupeModelCatalogEntries([...visibleCatalog, ...catalog]),
    runtimeChoicesByProvider,
    runtimeChoicesByModel,
    isCurrent: decisions.isCurrent,
  };
}

function formatProviderLine(params: { provider: string; count: number }): string {
  return `- ${params.provider} (${params.count})`;
}

function parseListArgs(tokens: string[]): Extract<ParsedModelsCommand, { action: "list" }> {
  const provider = normalizeOptionalString(tokens[0]);

  let page = 1;
  let all = false;
  for (const token of tokens.slice(1)) {
    const lower = normalizeLowercaseStringOrEmpty(token);
    if (lower === "all" || lower === "--all") {
      all = true;
      continue;
    }
    if (lower.startsWith("page=")) {
      const value = parseStrictPositiveInteger(lower.slice("page=".length));
      if (value !== undefined) {
        page = value;
      }
      continue;
    }
    const pageToken = parseStrictPositiveInteger(lower);
    if (pageToken !== undefined) {
      page = pageToken;
    }
  }

  let pageSize = PAGE_SIZE_DEFAULT;
  for (const token of tokens) {
    const lower = normalizeLowercaseStringOrEmpty(token);
    if (lower.startsWith("limit=") || lower.startsWith("size=")) {
      const rawValue = lower.slice(lower.indexOf("=") + 1);
      const value = parseStrictPositiveInteger(rawValue);
      if (value !== undefined) {
        pageSize = Math.min(PAGE_SIZE_MAX, value);
      }
    }
  }

  return {
    action: "list",
    provider: provider ? normalizeProviderId(provider) : undefined,
    page,
    pageSize,
    all,
  };
}

function parseModelsArgs(raw: string): ParsedModelsCommand {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { action: "providers" };
  }

  const tokens = trimmed.split(/\s+/g).filter(Boolean);
  const first = normalizeLowercaseStringOrEmpty(tokens[0]);
  switch (first) {
    case "providers":
      return { action: "providers" };
    case "list":
      return parseListArgs(tokens.slice(1));
    case "add":
      return {
        action: "add",
        provider: normalizeOptionalString(tokens[1]),
        modelId: normalizeOptionalString(tokens.slice(2).join(" ")),
      };
    default:
      return parseListArgs(tokens);
  }
}

function resolveProviderLabel(params: {
  provider: string;
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  sessionEntry?: ModelsCommandSessionEntry;
}): string {
  const harnessPolicy = resolveAgentHarnessPolicy({
    config: params.cfg,
    provider: params.provider,
    agentId: params.agentId,
  });
  const acceptedProviderIds = listOpenAIAuthProfileProvidersForAgentRuntime({
    provider: params.provider,
    harnessRuntime: harnessPolicy.runtime,
    config: params.cfg,
  });
  const authLabel = resolveModelAuthLabel({
    provider: params.provider,
    acceptedProviderIds,
    cfg: params.cfg,
    sessionEntry: params.sessionEntry,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
  });
  if (!authLabel || authLabel === "unknown") {
    return params.provider;
  }
  return `${params.provider} · 🔑 ${authLabel}`;
}

export function formatModelsAvailableHeader(params: {
  provider: string;
  total: number;
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  sessionEntry?: ModelsCommandSessionEntry;
}): string {
  const providerLabel = resolveProviderLabel({
    provider: params.provider,
    cfg: params.cfg,
    agentId: params.agentId,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    sessionEntry: params.sessionEntry,
  });
  return `Models (${providerLabel}) — ${params.total} available`;
}

function buildModelsMenuText(params: {
  providers: string[];
  byProvider: ReadonlyMap<string, ReadonlySet<string>>;
}): string {
  return [
    "Providers:",
    ...params.providers.map((provider) =>
      formatProviderLine({
        provider,
        count: params.byProvider.get(provider)?.size ?? 0,
      }),
    ),
    "",
    "Use: /models <provider>",
    "Switch: /model <provider/model>",
  ].join("\n");
}

function buildProviderInfos(params: {
  providers: string[];
  byProvider: ReadonlyMap<string, ReadonlySet<string>>;
}): Array<{ id: string; count: number }> {
  return params.providers.map((provider) => ({
    id: provider,
    count: params.byProvider.get(provider)?.size ?? 0,
  }));
}

export async function resolveModelsCommandReply(params: {
  cfg: OpenClawConfig;
  commandBodyNormalized: string;
  surface?: string;
  currentModel?: string;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  sessionEntry?: ModelsCommandSessionEntry;
}): Promise<ReplyPayload | null> {
  const body = params.commandBodyNormalized.trim();
  if (!body.startsWith("/models")) {
    return null;
  }

  const argText = body.replace(/^\/models\b/i, "").trim();
  const parsed = parseModelsArgs(argText);

  let data: PreparedModelsProviderData;
  try {
    data = await buildPreparedModelsProviderDataWithContext(
      params.cfg,
      params.agentId,
      {
        ...(parsed.action === "list" && parsed.all ? { view: "all" as const } : {}),
        workspaceDir: params.workspaceDir,
        sessionEntry: params.sessionEntry,
      },
      params.agentDir,
    );
  } catch (error) {
    if (error instanceof PreparedModelRuntimeOwnerNotPublishedError) {
      return {
        text: "Model catalog is not ready. Retry after Gateway startup or refresh finishes.",
      };
    }
    if (error instanceof PreparedModelRuntimePublicationSupersededError) {
      return { text: "Model catalog changed. Run /models again." };
    }
    throw error;
  }
  const { byProvider, providers, modelNames } = data;
  const commandPlugin = params.surface ? getChannelPlugin(params.surface) : null;
  const providerInfos = buildProviderInfos({ providers, byProvider });

  if (parsed.action === "providers") {
    const channelData =
      commandPlugin?.commands?.buildModelsMenuChannelData?.({
        providers: providerInfos,
      }) ??
      commandPlugin?.commands?.buildModelsProviderChannelData?.({
        providers: providerInfos,
      });
    if (channelData) {
      return {
        text: "Select a provider:",
        channelData,
      };
    }
    return {
      text: buildModelsMenuText({ providers, byProvider }),
    };
  }

  if (parsed.action === "add") {
    return { text: MODELS_ADD_DEPRECATED_TEXT };
  }

  const { provider, page, pageSize, all } = parsed;

  if (!provider) {
    const channelData = commandPlugin?.commands?.buildModelsProviderChannelData?.({
      providers: providerInfos,
    });
    if (channelData) {
      return {
        text: "Select a provider:",
        channelData,
      };
    }
    return {
      text: buildModelsMenuText({ providers, byProvider }),
    };
  }

  if (!byProvider.has(provider)) {
    return {
      text: [
        `Unknown provider: ${provider}`,
        "",
        "Available providers:",
        ...providers.map((entry) => `- ${entry}`),
        "",
        "Use: /models <provider>",
      ].join("\n"),
    };
  }

  const models = [...(byProvider.get(provider) ?? new Set<string>())].toSorted();
  const total = models.length;

  if (total === 0) {
    const emptyProviderLabel = resolveProviderLabel({
      provider,
      cfg: params.cfg,
      agentId: params.agentId,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      sessionEntry: params.sessionEntry,
    });
    return {
      text: [
        `Models (${emptyProviderLabel}) — none`,
        "",
        "Browse: /models",
        "Switch: /model <provider/model>",
      ].join("\n"),
    };
  }

  const interactivePageSize = 8;
  const interactiveTotalPages = Math.max(1, Math.ceil(total / interactivePageSize));
  const interactivePage = Math.max(1, Math.min(page, interactiveTotalPages));
  const interactiveChannelData = commandPlugin?.commands?.buildModelsListChannelData?.({
    provider,
    models,
    currentModel: params.currentModel,
    currentPage: interactivePage,
    totalPages: interactiveTotalPages,
    pageSize: interactivePageSize,
    modelNames,
  });
  if (interactiveChannelData) {
    return {
      text: formatModelsAvailableHeader({
        provider,
        total,
        cfg: params.cfg,
        agentId: params.agentId,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
        sessionEntry: params.sessionEntry,
      }),
      channelData: interactiveChannelData,
    };
  }

  const effectivePageSize = all ? total : pageSize;
  const pageCount = effectivePageSize > 0 ? Math.ceil(total / effectivePageSize) : 1;
  const safePage = all ? 1 : Math.max(1, Math.min(page, pageCount));

  if (!all && page !== safePage) {
    return {
      text: [
        `Page out of range: ${page} (valid: 1-${pageCount})`,
        "",
        `Try: /models list ${provider} ${safePage}`,
        `All: /models list ${provider} all`,
      ].join("\n"),
    };
  }

  const startIndex = (safePage - 1) * effectivePageSize;
  const endIndexExclusive = Math.min(total, startIndex + effectivePageSize);
  const pageModels = models.slice(startIndex, endIndexExclusive);
  const providerLabel = resolveProviderLabel({
    provider,
    cfg: params.cfg,
    agentId: params.agentId,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    sessionEntry: params.sessionEntry,
  });
  const lines = [
    `Models (${providerLabel}) — showing ${startIndex + 1}-${endIndexExclusive} of ${total} (page ${safePage}/${pageCount})`,
  ];
  for (const id of pageModels) {
    lines.push(`- ${provider}/${id}`);
  }
  lines.push("", "Switch: /model <provider/model>");
  if (!all && safePage < pageCount) {
    lines.push(`More: /models list ${provider} ${safePage + 1}`);
  }
  if (!all) {
    lines.push(`All: /models list ${provider} all`);
  }
  return { text: lines.join("\n") };
}

export const handleModelsCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const commandBodyNormalized = params.command.commandBodyNormalized.trim();
  if (!commandBodyNormalized.startsWith("/models")) {
    return null;
  }
  const parsed = parseModelsArgs(commandBodyNormalized.replace(/^\/models\b/i, "").trim());
  const unauthorized = rejectUnauthorizedCommand(params, "/models");
  if (unauthorized) {
    return unauthorized;
  }

  if (parsed.action === "add") {
    return { shouldContinue: false, reply: { text: MODELS_ADD_DEPRECATED_TEXT } };
  }

  const modelsAgentId = params.sessionKey
    ? resolveSessionAgentId({
        sessionKey: params.sessionKey,
        config: params.cfg,
      })
    : (params.agentId ?? "main");
  const currentAgentId = params.agentId ?? "main";
  const modelsAgentDir =
    modelsAgentId === currentAgentId && params.agentDir
      ? params.agentDir
      : resolveAgentDir(params.cfg, modelsAgentId);
  const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;

  const reply = await resolveModelsCommandReply({
    cfg: params.cfg,
    commandBodyNormalized,
    surface: params.ctx.Surface,
    currentModel: params.model ? `${params.provider}/${params.model}` : undefined,
    agentId: modelsAgentId,
    agentDir: modelsAgentDir,
    workspaceDir:
      targetSessionEntry?.spawnedWorkspaceDir ??
      (modelsAgentId === currentAgentId ? params.workspaceDir : undefined),
    sessionEntry: targetSessionEntry,
  });
  if (!reply) {
    return null;
  }
  return { reply, shouldContinue: false };
};
