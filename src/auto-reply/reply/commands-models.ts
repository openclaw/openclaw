import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveAgentDir,
  resolveAgentModelFallbacksOverride,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import { describeFailoverError } from "../../agents/failover-error.js";
import { resolveModelAuthLabel } from "../../agents/model-auth-label.js";
import { loadModelCatalog } from "../../agents/model-catalog.js";
import {
  buildAllowedModelSet,
  buildModelAliasIndex,
  normalizeProviderId,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveAgentModelFallbackValues } from "../../config/model-input.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  buildModelsKeyboard,
  buildProviderKeyboard,
  calculateTotalPages,
  getModelsPageSize,
  type ProviderInfo,
} from "../../telegram/model-buttons.js";
import type { ReplyPayload } from "../types.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;
const FALLBACK_TEST_PROMPT = "Reply with OK. Do not use tools.";
const FALLBACK_TEST_TIMEOUT_MS = 8_000;
const FALLBACK_TEST_MAX_TOKENS = 8;

type ResolvedModelRef = {
  provider: string;
  model: string;
};

export type ModelsProviderData = {
  byProvider: Map<string, Set<string>>;
  providers: string[];
  resolvedDefault: { provider: string; model: string };
};

/**
 * Build provider/model data from config and catalog.
 * Exported for reuse by callback handlers.
 */
export async function buildModelsProviderData(
  cfg: OpenClawConfig,
  agentId?: string,
): Promise<ModelsProviderData> {
  const resolvedDefault = resolveDefaultModelForAgent({
    cfg,
    agentId,
  });

  const catalog = await loadModelCatalog({ config: cfg });
  const allowed = buildAllowedModelSet({
    cfg,
    catalog,
    defaultProvider: resolvedDefault.provider,
    defaultModel: resolvedDefault.model,
  });

  const aliasIndex = buildModelAliasIndex({
    cfg,
    defaultProvider: resolvedDefault.provider,
  });

  const byProvider = new Map<string, Set<string>>();
  const add = (p: string, m: string) => {
    const key = normalizeProviderId(p);
    const set = byProvider.get(key) ?? new Set<string>();
    set.add(m);
    byProvider.set(key, set);
  };

  const addRawModelRef = (raw?: string) => {
    const trimmed = raw?.trim();
    if (!trimmed) {
      return;
    }
    const resolved = resolveModelRefFromString({
      raw: trimmed,
      defaultProvider: resolvedDefault.provider,
      aliasIndex,
    });
    if (!resolved) {
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

  for (const entry of allowed.allowedCatalog) {
    add(entry.provider, entry.id);
  }

  // Include config-only allowlist keys that aren't in the curated catalog.
  for (const raw of Object.keys(cfg.agents?.defaults?.models ?? {})) {
    addRawModelRef(raw);
  }

  // Ensure configured defaults/fallbacks/image models show up even when the
  // curated catalog doesn't know about them (custom providers, dev builds, etc.).
  add(resolvedDefault.provider, resolvedDefault.model);
  addModelConfigEntries();

  const providers = [...byProvider.keys()].toSorted();

  return { byProvider, providers, resolvedDefault };
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

function parseModelsFallbackTestArgs(raw: string): {
  enabled: boolean;
  all: boolean;
  invalidToken?: string;
} {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith("test-fallback")) {
    return { enabled: false, all: false };
  }

  const rest = trimmed.slice("test-fallback".length).trim();
  if (!rest) {
    return { enabled: true, all: false };
  }

  let all = false;
  for (const token of rest.split(/\s+/g).filter(Boolean)) {
    const lower = token.toLowerCase();
    if (lower === "all" || lower === "--all") {
      all = true;
      continue;
    }
    return { enabled: true, all, invalidToken: token };
  }

  return { enabled: true, all };
}

function resolveFallbackTestModels(params: { cfg: OpenClawConfig; agentId?: string }): {
  primary: ResolvedModelRef;
  fallbacks: ResolvedModelRef[];
} {
  const primary = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: primary.provider,
  });
  const defaultsFallbacks = resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model);
  const scopedFallbacks = params.agentId
    ? resolveAgentModelFallbacksOverride(params.cfg, params.agentId)
    : undefined;
  const rawFallbacks = scopedFallbacks ?? defaultsFallbacks;
  const fallbacks: ResolvedModelRef[] = [];
  const seen = new Set<string>();

  for (const raw of rawFallbacks) {
    const resolved = resolveModelRefFromString({
      raw,
      defaultProvider: primary.provider,
      aliasIndex,
    });
    if (!resolved) {
      continue;
    }
    const key = `${resolved.ref.provider}/${resolved.ref.model}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    fallbacks.push(resolved.ref);
  }

  return { primary, fallbacks };
}

function createFallbackProbeConfig(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  target: string;
}): OpenClawConfig {
  const defaults = {
    ...params.cfg.agents?.defaults,
    model: {
      primary: params.target,
      fallbacks: [],
    },
  };

  const list = Array.isArray(params.cfg.agents?.list)
    ? params.cfg.agents.list.map((entry) => {
        const entryId = typeof entry?.id === "string" ? entry.id.trim().toLowerCase() : "";
        const targetId = params.agentId?.trim().toLowerCase() ?? "";
        if (!targetId || entryId !== targetId) {
          return entry;
        }
        return {
          ...entry,
          model: {
            primary: params.target,
            fallbacks: [],
          },
        };
      })
    : params.cfg.agents?.list;

  return {
    ...params.cfg,
    agents: {
      ...params.cfg.agents,
      defaults,
      ...(list ? { list } : undefined),
    },
  };
}

function formatFallbackProbeFailure(err: unknown): string {
  const described = describeFailoverError(err);
  const reason = described.reason ? described.reason.replaceAll("_", " ") : "error";
  const detail = described.message.split("\n")[0]?.trim();
  return detail ? `${reason}: ${detail}` : reason;
}

async function probeFallbackModel(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  workspaceDir: string;
  target: ResolvedModelRef;
}): Promise<{ target: string; ok: boolean; detail?: string }> {
  const targetLabel = `${params.target.provider}/${params.target.model}`;
  const probeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-model-fallback-"));
  const sessionId = `models-test-fallback-${crypto.randomUUID()}`;
  const sessionFile = path.join(probeDir, `${sessionId}.jsonl`);

  try {
    await runEmbeddedPiAgent({
      sessionId,
      sessionKey: `probe:${sessionId}`,
      agentId: params.agentId,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      sessionFile,
      config: createFallbackProbeConfig({
        cfg: params.cfg,
        agentId: params.agentId,
        target: targetLabel,
      }),
      prompt: FALLBACK_TEST_PROMPT,
      provider: params.target.provider,
      model: params.target.model,
      disableTools: true,
      timeoutMs: FALLBACK_TEST_TIMEOUT_MS,
      runId: `models-test-fallback-${crypto.randomUUID()}`,
      lane: `models-test-fallback:${params.target.provider}:${params.target.model}`,
      thinkLevel: "off",
      reasoningLevel: "off",
      verboseLevel: "off",
      streamParams: { maxTokens: FALLBACK_TEST_MAX_TOKENS },
    });
    return { target: targetLabel, ok: true };
  } catch (err) {
    return { target: targetLabel, ok: false, detail: formatFallbackProbeFailure(err) };
  } finally {
    await fs.rm(probeDir, { recursive: true, force: true });
  }
}

export async function resolveModelsCommandReply(params: {
  cfg: OpenClawConfig;
  commandBodyNormalized: string;
  surface?: string;
  currentModel?: string;
  agentId?: string;
  agentDir?: string;
  sessionEntry?: SessionEntry;
  workspaceDir?: string;
}): Promise<ReplyPayload | null> {
  const body = params.commandBodyNormalized.trim();
  if (!body.startsWith("/models")) {
    return null;
  }

  const argText = body.replace(/^\/models\b/i, "").trim();
  const fallbackTest = parseModelsFallbackTestArgs(argText);
  if (fallbackTest.enabled) {
    if (fallbackTest.invalidToken) {
      return {
        text: [
          `Unknown /models test-fallback argument: ${fallbackTest.invalidToken}`,
          "",
          "Use: /models test-fallback",
          "All: /models test-fallback all",
        ].join("\n"),
      };
    }

    const { primary, fallbacks } = resolveFallbackTestModels({
      cfg: params.cfg,
      agentId: params.agentId,
    });
    const primaryLabel = `${primary.provider}/${primary.model}`;
    if (fallbacks.length === 0) {
      return {
        text: [
          `No fallback models configured for ${primaryLabel}.`,
          "",
          "Set fallbacks in config, then retry:",
          "Use: /models test-fallback",
        ].join("\n"),
      };
    }

    const targets = fallbackTest.all ? fallbacks : fallbacks.slice(0, 1);
    const workspaceDir = params.workspaceDir ?? process.cwd();
    const results = [];
    for (const target of targets) {
      results.push(
        await probeFallbackModel({
          cfg: params.cfg,
          agentId: params.agentId,
          agentDir: params.agentDir,
          workspaceDir,
          target,
        }),
      );
    }

    const lines = [`Fallback test (primary skipped: ${primaryLabel})`];
    for (const result of results) {
      lines.push(`- ${result.target}: ${result.ok ? "OK" : (result.detail ?? "error")}`);
    }
    if (!fallbackTest.all && fallbacks.length > 1) {
      lines.push("", "More: /models test-fallback all");
    }
    return { text: lines.join("\n") };
  }

  const { provider, page, pageSize, all } = parseModelsArgs(argText);

  const { byProvider, providers } = await buildModelsProviderData(params.cfg, params.agentId);
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
    workspaceDir: params.workspaceDir,
  });
  if (!reply) {
    return null;
  }
  return { reply, shouldContinue: false };
};
