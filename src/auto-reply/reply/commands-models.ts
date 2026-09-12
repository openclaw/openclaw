// Implements model listing and provider catalog commands.
import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveAgentDir, resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import { resolveModelAuthLabel } from "../../agents/model-auth-label.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import { listOpenAIAuthProfileProvidersForAgentRuntime } from "../../agents/openai-routing.js";
import * as preparedModelCatalog from "../../agents/prepared-model-catalog.js";
import {
  PreparedModelRuntimeOwnerNotPublishedError,
  PreparedModelRuntimePublicationSupersededError,
} from "../../agents/prepared-model-runtime.errors.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ReplyPayload } from "../types.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import { projectPreparedModelsProviderData } from "./commands-models-catalog.js";
import { formatModelsAllowListNotice } from "./commands-models-notice.js";
import type {
  ModelsBrowseOptions,
  ModelsCommandSessionEntry,
  ModelsProviderData,
  ModelsProviderMenu,
  ModelsRuntimeChoice,
  PreparedModelsProviderData,
} from "./commands-models.types.js";
import type { CommandHandler } from "./commands-types.js";

export type { ModelsProviderData, ModelsRuntimeChoice } from "./commands-models.types.js";

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;
const MODELS_ADD_DEPRECATED_TEXT =
  "⚠️ /models add is deprecated. Use /models to browse providers and /model to switch models.";
export const MODEL_PICKER_CHANGED_MESSAGE =
  "Available models changed. Open /models and choose again.";

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
  availability?: ModelsProviderMenu;
}): string {
  const providerLabel = resolveProviderLabel({
    provider: params.provider,
    cfg: params.cfg,
    agentId: params.agentId,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    sessionEntry: params.sessionEntry,
  });
  const count =
    params.availability && params.availability.available !== params.total
      ? `${params.availability.available} of ${params.total}`
      : String(params.total);
  return [`Models (${providerLabel}) — ${count} available`, params.availability?.notice]
    .filter(Boolean)
    .join("\n\n");
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

type ModelsCommandReplyParams = {
  cfg: OpenClawConfig;
  commandBodyNormalized: string;
  surface?: string;
  currentModel?: string;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  sessionEntry?: ModelsCommandSessionEntry;
  sessionKey?: string;
};

export async function resolveModelsCommandReply(
  params: ModelsCommandReplyParams,
): Promise<ReplyPayload | null> {
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
        workspaceDir: params.workspaceDir,
        sessionEntry: params.sessionEntry,
        sessionKey: params.sessionKey,
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
      return { text: MODEL_PICKER_CHANGED_MESSAGE };
    }
    throw error;
  }
  const notice = formatModelsAllowListNotice(data.allowList, data.providers.length > 0);
  if (data.providers.length === 0 && data.allowList) {
    return { text: notice };
  }
  const reply = buildModelsCommandReply(params, parsed, data);
  return { ...reply, text: [data.refreshWarning, reply.text, notice].filter(Boolean).join("\n\n") };
}

function buildModelsCommandReply(
  params: ModelsCommandReplyParams,
  parsed: ParsedModelsCommand,
  data: PreparedModelsProviderData,
): ReplyPayload & { text: string } {
  const { byProvider, providers } = data;
  const availability =
    parsed.action === "list" && parsed.provider
      ? data.modelMenu?.byProvider.get(parsed.provider)
      : undefined;
  const modelNames = data.modelMenu?.modelNames ?? data.modelNames;
  const notice =
    parsed.action === "list" && parsed.provider
      ? availability?.notice
      : [...(data.modelMenu?.byProvider.values() ?? [])]
          .map((provider) => provider.notice)
          .filter(Boolean)
          .join("\n");
  const checking = data.pendingProviders
    ?.filter(
      (provider) => parsed.action !== "list" || !parsed.provider || parsed.provider === provider,
    )
    .map((provider) => `${provider}: checking models…`)
    .join("\n");
  const withAvailability = (text: string) => [text, notice, checking].filter(Boolean).join("\n\n");
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
        text: withAvailability("Select a provider:"),
        channelData,
      };
    }
    return {
      text: withAvailability(buildModelsMenuText({ providers, byProvider })),
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
        text: withAvailability("Select a provider:"),
        channelData,
      };
    }
    return {
      text: withAvailability(buildModelsMenuText({ providers, byProvider })),
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
    if (checking) {
      return { text: [notice, checking].filter(Boolean).join("\n\n") };
    }
    const emptyProviderLabel = resolveProviderLabel({
      provider,
      cfg: params.cfg,
      agentId: params.agentId,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      sessionEntry: params.sessionEntry,
    });
    return {
      text: withAvailability(
        [
          `Models (${emptyProviderLabel}) — none`,
          "",
          "Browse: /models",
          "Switch: /model <provider/model>",
        ].join("\n"),
      ),
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
        availability,
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
    const key = `${provider}/${id}`;
    const label = modelNames.get(key);
    const primary =
      provider === data.effectiveDefault?.provider && id === data.effectiveDefault?.model;
    lines.push(
      `- ${key}${primary ? " (Default)" : ""}${label && label !== data.modelNames.get(key) ? ` (${label})` : ""}`,
    );
  }
  lines.push("", "Switch: /model <provider/model>");
  if (!all && safePage < pageCount) {
    lines.push(`More: /models list ${provider} ${safePage + 1}`);
  }
  if (!all) {
    lines.push(`All: /models list ${provider} all`);
  }
  return { text: withAvailability(lines.join("\n")) };
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
    sessionKey: params.sessionKey,
  });
  if (!reply) {
    return null;
  }
  return { reply, shouldContinue: false };
};
