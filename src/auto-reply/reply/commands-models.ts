import { resolveAgentDir, resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveModelAuthLabel } from "../../agents/model-auth-label.js";
import { loadModelCatalog } from "../../agents/model-catalog.js";
import {
  buildAllowedModelSet,
  buildModelAliasIndex,
  normalizeProviderId,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { ReplyPayload } from "../types.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import {
  buildModelsKeyboard,
  buildProviderKeyboard,
  calculateTotalPages,
  getModelsPageSize,
  type ProviderInfo,
} from "./commands-models.telegram.js";
import type { CommandHandler } from "./commands-types.js";

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;

export type ModelsProviderData = {
  byProvider: Map<string, Set<string>>;
  providers: string[];
  resolvedDefault: { provider: string; model: string };
  /** Map from provider/model to human-readable display name (when different from model ID). */
  modelNames: Map<string, string>;
};

function addProviderModel(byProvider: Map<string, Set<string>>, provider: string, model: string) {
  const key = normalizeProviderId(provider);
  const set = byProvider.get(key) ?? new Set<string>();
  set.add(model);
  byProvider.set(key, set);
}

function buildConfiguredProviderModelMap(params: {
  cfg: OpenClawConfig;
  resolvedDefault: { provider: string; model: string };
}): Map<string, Set<string>> {
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: params.resolvedDefault.provider,
  });
  const byProvider = new Map<string, Set<string>>();

  const addRawModelRef = (raw?: string) => {
    const trimmed = raw?.trim();
    if (!trimmed) {
      return;
    }
    const resolved = resolveModelRefFromString({
      raw: trimmed,
      defaultProvider: params.resolvedDefault.provider,
      aliasIndex,
    });
    if (!resolved) {
      return;
    }
    addProviderModel(byProvider, resolved.ref.provider, resolved.ref.model);
  };

  const addModelConfigEntries = () => {
    const modelConfig = params.cfg.agents?.defaults?.model;
    if (typeof modelConfig === "string") {
      addRawModelRef(modelConfig);
    } else if (modelConfig && typeof modelConfig === "object") {
      addRawModelRef(modelConfig.primary);
      for (const fallback of modelConfig.fallbacks ?? []) {
        addRawModelRef(fallback);
      }
    }

    const imageConfig = params.cfg.agents?.defaults?.imageModel;
    if (typeof imageConfig === "string") {
      addRawModelRef(imageConfig);
    } else if (imageConfig && typeof imageConfig === "object") {
      addRawModelRef(imageConfig.primary);
      for (const fallback of imageConfig.fallbacks ?? []) {
        addRawModelRef(fallback);
      }
    }
  };

  for (const raw of Object.keys(params.cfg.agents?.defaults?.models ?? {})) {
    addRawModelRef(raw);
  }

  // Always include the resolved default model even when it is not in the
  // curated catalog yet (custom providers, discovery-backed providers, etc.).
  addProviderModel(byProvider, params.resolvedDefault.provider, params.resolvedDefault.model);
  addModelConfigEntries();

  return byProvider;
}

export function buildConfiguredModelsProviderData(
  cfg: OpenClawConfig,
  agentId?: string,
): ModelsProviderData {
  const resolvedDefault = resolveDefaultModelForAgent({
    cfg,
    agentId,
  });
  const byProvider = buildConfiguredProviderModelMap({
    cfg,
    resolvedDefault,
  });
  const providers = [...byProvider.keys()].toSorted();
  return { byProvider, providers, resolvedDefault, modelNames: new Map<string, string>() };
}

/**
 * Build provider/model data from config and catalog.
 * Exported for reuse by callback handlers.
 */
export async function buildModelsProviderData(
  cfg: OpenClawConfig,
  agentId?: string,
): Promise<ModelsProviderData> {
  const configured = buildConfiguredModelsProviderData(cfg, agentId);
  const resolvedDefault = configured.resolvedDefault;
  const byProvider = new Map(
    [...configured.byProvider.entries()].map(([provider, models]) => [provider, new Set(models)]),
  );

  const catalog = await loadModelCatalog({ config: cfg });
  const allowed = buildAllowedModelSet({
    cfg,
    catalog,
    defaultProvider: resolvedDefault.provider,
    defaultModel: resolvedDefault.model,
    agentId,
  });

  for (const entry of allowed.allowedCatalog) {
    addProviderModel(byProvider, entry.provider, entry.id);
  }

  const providers = [...byProvider.keys()].toSorted();

  // Build a provider-scoped model display-name map so surfaces can show
  // human-readable names without colliding across providers that share IDs.
  const modelNames = new Map<string, string>();
  for (const entry of catalog) {
    if (entry.name && entry.name !== entry.id) {
      modelNames.set(`${normalizeProviderId(entry.provider)}/${entry.id}`, entry.name);
    }
  }

  return { byProvider, providers, resolvedDefault, modelNames };
}

function formatProviderLine(params: { provider: string; count: number }): string {
  return `- ${params.provider} (${params.count})`;
}

function parseModelsArgs(raw: string): {
  provider?: string;
  page: number;
  pageSize: number;
  all: boolean;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { page: 1, pageSize: PAGE_SIZE_DEFAULT, all: false };
  }

  const tokens = trimmed.split(/\s+/g).filter(Boolean);
  const provider = tokens[0]?.trim();

  let page = 1;
  let all = false;
  for (const token of tokens.slice(1)) {
    const lower = token.toLowerCase();
    if (lower === "all" || lower === "--all") {
      all = true;
      continue;
    }
    if (lower.startsWith("page=")) {
      const value = Number.parseInt(lower.slice("page=".length), 10);
      if (Number.isFinite(value) && value > 0) {
        page = value;
      }
      continue;
    }
    if (/^[0-9]+$/.test(lower)) {
      const value = Number.parseInt(lower, 10);
      if (Number.isFinite(value) && value > 0) {
        page = value;
      }
    }
  }

  let pageSize = PAGE_SIZE_DEFAULT;
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower.startsWith("limit=") || lower.startsWith("size=")) {
      const rawValue = lower.slice(lower.indexOf("=") + 1);
      const value = Number.parseInt(rawValue, 10);
      if (Number.isFinite(value) && value > 0) {
        pageSize = Math.min(PAGE_SIZE_MAX, value);
      }
    }
  }

  return {
    provider: provider ? normalizeProviderId(provider) : undefined,
    page,
    pageSize,
    all,
  };
}

function resolveProviderLabel(params: {
  provider: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  sessionEntry?: SessionEntry;
}): string {
  const authLabel = resolveModelAuthLabel({
    provider: params.provider,
    cfg: params.cfg,
    sessionEntry: params.sessionEntry,
    agentDir: params.agentDir,
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
  agentDir?: string;
  sessionEntry?: SessionEntry;
}): string {
  const providerLabel = resolveProviderLabel({
    provider: params.provider,
    cfg: params.cfg,
    agentDir: params.agentDir,
    sessionEntry: params.sessionEntry,
  });
  return `Models (${providerLabel}) — ${params.total} available`;
}

export async function resolveModelsCommandReply(params: {
  cfg: OpenClawConfig;
  commandBodyNormalized: string;
  surface?: string;
  currentModel?: string;
  agentId?: string;
  agentDir?: string;
  sessionEntry?: SessionEntry;
}): Promise<ReplyPayload | null> {
  const body = params.commandBodyNormalized.trim();
  if (!body.startsWith("/models")) {
    return null;
  }

  const argText = body.replace(/^\/models\b/i, "").trim();
  const { provider, page, pageSize, all } = parseModelsArgs(argText);

  const { byProvider, providers, modelNames } = await buildModelsProviderData(
    params.cfg,
    params.agentId,
  );
  const isTelegram = params.surface === "telegram";

  // Provider list (no provider specified)
  if (!provider) {
    // For Telegram: show buttons if there are providers
    if (isTelegram && providers.length > 0) {
      const providerInfos: ProviderInfo[] = providers.map((p) => ({
        id: p,
        count: byProvider.get(p)?.size ?? 0,
      }));
      const buttons = buildProviderKeyboard(providerInfos);
      const text = "Select a provider:";
      return {
        text,
        channelData: { telegram: { buttons } },
      };
    }

    // Text fallback for non-Telegram surfaces
    const lines: string[] = [
      "Providers:",
      ...providers.map((p) =>
        formatProviderLine({ provider: p, count: byProvider.get(p)?.size ?? 0 }),
      ),
      "",
      "Use: /models <provider>",
      "Switch: /model <provider/model>",
    ];
    return { text: lines.join("\n") };
  }

  if (!byProvider.has(provider)) {
    const lines: string[] = [
      `Unknown provider: ${provider}`,
      "",
      "Available providers:",
      ...providers.map((p) => `- ${p}`),
      "",
      "Use: /models <provider>",
    ];
    return { text: lines.join("\n") };
  }

  const models = [...(byProvider.get(provider) ?? new Set<string>())].toSorted();
  const total = models.length;
  const providerLabel = resolveProviderLabel({
    provider,
    cfg: params.cfg,
    agentDir: params.agentDir,
    sessionEntry: params.sessionEntry,
  });

  if (total === 0) {
    const lines: string[] = [
      `Models (${providerLabel}) — none`,
      "",
      "Browse: /models",
      "Switch: /model <provider/model>",
    ];
    return { text: lines.join("\n") };
  }

  // For Telegram: use button-based model list with inline keyboard pagination
  if (isTelegram) {
    const telegramPageSize = getModelsPageSize();
    const totalPages = calculateTotalPages(total, telegramPageSize);
    const safePage = Math.max(1, Math.min(page, totalPages));

    const buttons = buildModelsKeyboard({
      provider,
      models,
      currentModel: params.currentModel,
      currentPage: safePage,
      totalPages,
      pageSize: telegramPageSize,
      modelNames,
    });

    const text = formatModelsAvailableHeader({
      provider,
      total,
      cfg: params.cfg,
      agentDir: params.agentDir,
      sessionEntry: params.sessionEntry,
    });
    return {
      text,
      channelData: { telegram: { buttons } },
    };
  }

  // Text fallback for non-Telegram surfaces
  const effectivePageSize = all ? total : pageSize;
  const pageCount = effectivePageSize > 0 ? Math.ceil(total / effectivePageSize) : 1;
  const safePage = all ? 1 : Math.max(1, Math.min(page, pageCount));

  if (!all && page !== safePage) {
    const lines: string[] = [
      `Page out of range: ${page} (valid: 1-${pageCount})`,
      "",
      `Try: /models ${provider} ${safePage}`,
      `All: /models ${provider} all`,
    ];
    return { text: lines.join("\n") };
  }

  const startIndex = (safePage - 1) * effectivePageSize;
  const endIndexExclusive = Math.min(total, startIndex + effectivePageSize);
  const pageModels = models.slice(startIndex, endIndexExclusive);

  const header = `Models (${providerLabel}) — showing ${startIndex + 1}-${endIndexExclusive} of ${total} (page ${safePage}/${pageCount})`;

  const lines: string[] = [header];
  for (const id of pageModels) {
    lines.push(`- ${provider}/${id}`);
  }

  lines.push("", "Switch: /model <provider/model>");
  if (!all && safePage < pageCount) {
    lines.push(`More: /models ${provider} ${safePage + 1}`);
  }
  if (!all) {
    lines.push(`All: /models ${provider} all`);
  }

  const payload: ReplyPayload = { text: lines.join("\n") };
  return payload;
}

export const handleModelsCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const commandBodyNormalized = params.command.commandBodyNormalized.trim();
  if (!commandBodyNormalized.startsWith("/models")) {
    return null;
  }
  const unauthorized = rejectUnauthorizedCommand(params, "/models");
  if (unauthorized) {
    return unauthorized;
  }

  const modelsAgentId =
    params.agentId ??
    resolveSessionAgentId({
      sessionKey: params.sessionKey,
      config: params.cfg,
    });
  const modelsAgentDir = resolveAgentDir(params.cfg, modelsAgentId);

  const reply = await resolveModelsCommandReply({
    cfg: params.cfg,
    commandBodyNormalized,
    surface: params.ctx.Surface,
    currentModel: params.model ? `${params.provider}/${params.model}` : undefined,
    agentId: modelsAgentId,
    agentDir: modelsAgentDir,
    sessionEntry: params.sessionEntry,
  });
  if (!reply) {
    return null;
  }
  return { reply, shouldContinue: false };
};
