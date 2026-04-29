/**
 * 默认配置值模块
 * 提供配置默认值解析和应用功能，确保配置在使用前具有合理的默认值
 */

import { DEFAULT_CONTEXT_TOKENS } from "../agents/defaults.js";
import { normalizeProviderId } from "../agents/provider-id.js";
import { DEFAULT_AGENT_MAX_CONCURRENT, DEFAULT_SUBAGENT_MAX_CONCURRENT } from "./agent-limits.js";
import {
  applyProviderConfigDefaultsForConfig,
  normalizeProviderConfigForConfigDefaults,
} from "./provider-policy.js";
import { normalizeTalkConfig } from "./talk.js";
import type { ModelDefinitionConfig } from "./types.models.js";
import type { OpenClawConfig } from "./types.openclaw.js";

/**
 * 警告状态类型
 * 用于跟踪配置警告状态，避免重复输出相同的警告信息
 */
type WarnState = { warned: boolean };

/**
 * 默认警告状态
 * 模块级别的警告状态，用于测试场景下的状态重置
 */
let defaultWarnState: WarnState = { warned: false };

/**
 * 默认模型别名映射表
 * 将短名称映射到完整的模型标识符
 * 例如: "opus" -> "anthropic/claude-opus-4-7"
 */
const DEFAULT_MODEL_ALIASES: Readonly<Record<string, string>> = {
  // Anthropic (pi-ai catalog uses "latest" ids without date suffix)
  opus: "anthropic/claude-opus-4-7",
  sonnet: "anthropic/claude-sonnet-4-6",

  // OpenAI
  gpt: "openai/gpt-5.4",
  "gpt-mini": "openai/gpt-5.4-mini",
  "gpt-nano": "openai/gpt-5.4-nano",

  // Google Gemini (3.x are preview ids in the catalog)
  gemini: "google/gemini-3.1-pro-preview",
  "gemini-flash": "google/gemini-3-flash-preview",
  "gemini-flash-lite": "google/gemini-3.1-flash-lite-preview",
};

/**
 * 默认模型成本配置
 * 所有模型成本默认为 0，需要用户根据实际使用情况配置
 */
const DEFAULT_MODEL_COST: ModelDefinitionConfig["cost"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/**
 * 默认模型输入类型
 * 默认为纯文本输入
 */
const DEFAULT_MODEL_INPUT: ModelDefinitionConfig["input"] = ["text"];

/**
 * 默认模型最大 token 数量
 */
const DEFAULT_MODEL_MAX_TOKENS = 8192;

/**
 * Mistral 模型的安全最大 token 限制映射表
 * 不同模型有不同的最大 token 限制
 */
const MISTRAL_SAFE_MAX_TOKENS_BY_MODEL = {
  "devstral-medium-latest": 32_768,
  "magistral-small": 40_000,
  "mistral-large-latest": 16_384,
  "mistral-medium-2508": 8_192,
  "mistral-small-latest": 16_384,
  "pixtral-large-latest": 32_768,
} as const;

/**
 * 模型定义的可选参数类型
 * 必须包含 id 和 name，可选包含其他 ModelDefinitionConfig 属性
 */
type ModelDefinitionLike = Partial<ModelDefinitionConfig> &
  Pick<ModelDefinitionConfig, "id" | "name">;

/**
 * 判断值是否为正数
 * @param value - 待检查的值
 * @returns 是否为正数
 */
function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * 解析模型成本配置
 * @param raw - 原始成本配置（可选）
 * @returns 解析后的成本配置，确保所有字段都是有效数字
 */
function resolveModelCost(
  raw?: Partial<ModelDefinitionConfig["cost"]>,
): ModelDefinitionConfig["cost"] {
  return {
    input: typeof raw?.input === "number" ? raw.input : DEFAULT_MODEL_COST.input,
    output: typeof raw?.output === "number" ? raw.output : DEFAULT_MODEL_COST.output,
    cacheRead: typeof raw?.cacheRead === "number" ? raw.cacheRead : DEFAULT_MODEL_COST.cacheRead,
    cacheWrite:
      typeof raw?.cacheWrite === "number" ? raw.cacheWrite : DEFAULT_MODEL_COST.cacheWrite,
    ...(raw?.tieredPricing ? { tieredPricing: raw.tieredPricing } : {}),
  };
}

/**
 * 解析规范化后的提供商模型最大 token 数量
 * 针对 Mistral 模型有特殊的安全限制处理
 * @param params - 包含 providerId, modelId, contextWindow, rawMaxTokens
 * @returns 最终的最大 token 数量
 */
export function resolveNormalizedProviderModelMaxTokens(params: {
  providerId: string;
  modelId: string;
  contextWindow: number;
  rawMaxTokens: number;
}): number {
  const clamped = Math.min(params.rawMaxTokens, params.contextWindow);
  if (normalizeProviderId(params.providerId) !== "mistral" || clamped < params.contextWindow) {
    return clamped;
  }

  const safeMaxTokens =
    MISTRAL_SAFE_MAX_TOKENS_BY_MODEL[
      params.modelId as keyof typeof MISTRAL_SAFE_MAX_TOKENS_BY_MODEL
    ] ?? DEFAULT_MODEL_MAX_TOKENS;
  return Math.min(safeMaxTokens, params.contextWindow);
}

/**
 * 会话默认值选项
 */
export type SessionDefaultsOptions = {
  /** 自定义警告函数 */
  warn?: (message: string) => void;
  /** 警告状态对象 */
  warnState?: WarnState;
};

/**
 * 应用消息默认值
 * 如果配置中未设置 ackReactionScope，则默认设置为 "group-mentions"
 * @param cfg - OpenClaw 配置对象
 * @returns 应用默认值后的配置对象
 */
export function applyMessageDefaults(cfg: OpenClawConfig): OpenClawConfig {
  const messages = cfg.messages;
  const hasAckScope = messages?.ackReactionScope !== undefined;
  if (hasAckScope) {
    return cfg;
  }

  const nextMessages = messages ? { ...messages } : {};
  nextMessages.ackReactionScope = "group-mentions";
  return {
    ...cfg,
    messages: nextMessages,
  };
}

/**
 * 应用会话默认值
 * 确保 session.mainKey 始终为 "main"，并发出警告如果用户设置了其他值
 * @param cfg - OpenClaw 配置对象
 * @param options - 可选的警告配置
 * @returns 应用默认值后的配置对象
 */
export function applySessionDefaults(
  cfg: OpenClawConfig,
  options: SessionDefaultsOptions = {},
): OpenClawConfig {
  const session = cfg.session;
  if (!session || session.mainKey === undefined) {
    return cfg;
  }

  const trimmed = session.mainKey.trim();
  const warn = options.warn ?? console.warn;
  const warnState = options.warnState ?? defaultWarnState;

  const next: OpenClawConfig = {
    ...cfg,
    session: { ...session, mainKey: "main" },
  };

  if (trimmed && trimmed !== "main" && !warnState.warned) {
    warnState.warned = true;
    warn('session.mainKey is ignored; main session is always "main".');
  }

  return next;
}

/**
 * 应用 Talk 配置规范化
 * @param config - OpenClaw 配置对象
 * @returns 规范化后的配置对象
 */
export function applyTalkConfigNormalization(config: OpenClawConfig): OpenClawConfig {
  return normalizeTalkConfig(config);
}

/**
 * 应用模型默认值
 * 为所有模型配置设置默认值，包括 reasoning、input、cost、contextWindow、maxTokens 等
 * @param cfg - OpenClaw 配置对象
 * @returns 应用默认值后的配置对象
 */
export function applyModelDefaults(cfg: OpenClawConfig): OpenClawConfig {
  let mutated = false;
  let nextCfg = cfg;

  const providerConfig = nextCfg.models?.providers;
  if (providerConfig) {
    const nextProviders = { ...providerConfig };
    for (const [providerId, provider] of Object.entries(providerConfig)) {
      const normalizedProvider = normalizeProviderConfigForConfigDefaults({
        provider: providerId,
        providerConfig: provider,
      });
      const models = normalizedProvider.models;
      if (!Array.isArray(models) || models.length === 0) {
        if (normalizedProvider !== provider) {
          nextProviders[providerId] = normalizedProvider;
          mutated = true;
        }
        continue;
      }
      const providerApi = normalizedProvider.api;
      let nextProvider = normalizedProvider;
      if (nextProvider !== provider) {
        mutated = true;
      }
      let providerMutated = false;
      const nextModels = models.map((model) => {
        const raw = model as ModelDefinitionLike;
        let modelMutated = false;

        // 解析 reasoning 配置，默认为 false
        const reasoning = typeof raw.reasoning === "boolean" ? raw.reasoning : false;
        if (raw.reasoning !== reasoning) {
          modelMutated = true;
        }

        // 解析 input 配置，默认为纯文本
        const input = raw.input ?? [...DEFAULT_MODEL_INPUT];
        if (raw.input === undefined) {
          modelMutated = true;
        }

        // 解析 cost 配置
        const cost = resolveModelCost(raw.cost);
        const costMutated =
          !raw.cost ||
          raw.cost.input !== cost.input ||
          raw.cost.output !== cost.output ||
          raw.cost.cacheRead !== cost.cacheRead ||
          raw.cost.cacheWrite !== cost.cacheWrite;
        if (costMutated) {
          modelMutated = true;
        }

        // 解析 contextWindow 配置
        const contextWindow = isPositiveNumber(raw.contextWindow)
          ? raw.contextWindow
          : DEFAULT_CONTEXT_TOKENS;
        if (raw.contextWindow !== contextWindow) {
          modelMutated = true;
        }

        // 解析 maxTokens 配置
        const defaultMaxTokens = Math.min(DEFAULT_MODEL_MAX_TOKENS, contextWindow);
        const rawMaxTokens = isPositiveNumber(raw.maxTokens) ? raw.maxTokens : defaultMaxTokens;
        const maxTokens = resolveNormalizedProviderModelMaxTokens({
          providerId,
          modelId: raw.id,
          contextWindow,
          rawMaxTokens,
        });
        if (raw.maxTokens !== maxTokens) {
          modelMutated = true;
        }
        const api = raw.api ?? providerApi;
        if (raw.api !== api) {
          modelMutated = true;
        }

        if (!modelMutated) {
          return model;
        }
        providerMutated = true;
        return Object.assign({}, raw, {
          reasoning,
          input,
          cost,
          contextWindow,
          maxTokens,
          api,
        }) as ModelDefinitionConfig;
      });

      if (!providerMutated) {
        if (nextProvider !== provider) {
          nextProviders[providerId] = nextProvider;
        }
        continue;
      }
      nextProviders[providerId] = { ...nextProvider, models: nextModels };
      mutated = true;
    }

    if (mutated) {
      nextCfg = {
        ...nextCfg,
        models: {
          ...nextCfg.models,
          providers: nextProviders,
        },
      };
    }
  }

  // 应用默认模型别名
  const existingAgent = nextCfg.agents?.defaults;
  if (!existingAgent) {
    return mutated ? nextCfg : cfg;
  }
  const existingModels = existingAgent.models ?? {};
  if (Object.keys(existingModels).length === 0) {
    return mutated ? nextCfg : cfg;
  }

  const nextModels: Record<string, { alias?: string }> = {
    ...existingModels,
  };

  for (const [alias, target] of Object.entries(DEFAULT_MODEL_ALIASES)) {
    const entry = nextModels[target];
    if (!entry) {
      continue;
    }
    if (entry.alias !== undefined) {
      continue;
    }
    nextModels[target] = { ...entry, alias };
    mutated = true;
  }

  if (!mutated) {
    return cfg;
  }

  return {
    ...nextCfg,
    agents: {
      ...nextCfg.agents,
      defaults: { ...existingAgent, models: nextModels },
    },
  };
}

/**
 * 应用 Agent 默认值
 * 设置 maxConcurrent 和 subagents.maxConcurrent 的默认值
 * @param cfg - OpenClaw 配置对象
 * @returns 应用默认值后的配置对象
 */
export function applyAgentDefaults(cfg: OpenClawConfig): OpenClawConfig {
  const agents = cfg.agents;
  const defaults = agents?.defaults;
  const hasMax =
    typeof defaults?.maxConcurrent === "number" && Number.isFinite(defaults.maxConcurrent);
  const hasSubMax =
    typeof defaults?.subagents?.maxConcurrent === "number" &&
    Number.isFinite(defaults.subagents.maxConcurrent);
  if (hasMax && hasSubMax) {
    return cfg;
  }

  let mutated = false;
  const nextDefaults = defaults ? { ...defaults } : {};
  if (!hasMax) {
    nextDefaults.maxConcurrent = DEFAULT_AGENT_MAX_CONCURRENT;
    mutated = true;
  }

  const nextSubagents = defaults?.subagents ? { ...defaults.subagents } : {};
  if (!hasSubMax) {
    nextSubagents.maxConcurrent = DEFAULT_SUBAGENT_MAX_CONCURRENT;
    mutated = true;
  }

  if (!mutated) {
    return cfg;
  }

  return {
    ...cfg,
    agents: {
      ...agents,
      defaults: {
        ...nextDefaults,
        subagents: nextSubagents,
      },
    },
  };
}

/**
 * 应用日志默认值
 * 如果未设置 redactSensitive，则默认为 "tools"
 * @param cfg - OpenClaw 配置对象
 * @returns 应用默认值后的配置对象
 */
export function applyLoggingDefaults(cfg: OpenClawConfig): OpenClawConfig {
  const logging = cfg.logging;
  if (!logging) {
    return cfg;
  }
  if (logging.redactSensitive) {
    return cfg;
  }
  return {
    ...cfg,
    logging: {
      ...logging,
      redactSensitive: "tools",
    },
  };
}

/**
 * 检查配置是否使用 Anthropic 默认信号
 * 用于判断是否需要应用特定的上下文剪枝默认值
 * @param cfg - OpenClaw 配置对象
 * @param env - 进程环境变量
 * @returns 是否使用 Anthropic 默认信号
 */
function hasAnthropicDefaultSignal(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): boolean {
  // 检查环境变量中是否设置了 Anthropic API 密钥
  if (env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_OAUTH_TOKEN?.trim()) {
    return true;
  }
  // 检查认证配置文件中是否包含 Anthropic 提供商
  const profiles = cfg.auth?.profiles;
  if (profiles) {
    for (const profile of Object.values(profiles)) {
      const provider = normalizeProviderId(profile?.provider);
      if (provider === "anthropic" || provider === "claude-cli") {
        return true;
      }
    }
  }
  // 检查认证顺序中是否包含 Anthropic 提供商
  const order = cfg.auth?.order;
  if (!order) {
    return false;
  }
  return Object.keys(order).some((provider) => {
    const normalizedProvider = normalizeProviderId(provider);
    if (normalizedProvider !== "anthropic" && normalizedProvider !== "claude-cli") {
      return false;
    }
    return (order as Record<string, unknown>)[provider] !== undefined;
  });
}

/**
 * 应用上下文剪枝默认值
 * 当检测到 Anthropic 默认信号时，应用提供商配置的默认值
 * @param cfg - OpenClaw 配置对象
 * @returns 应用默认值后的配置对象
 */
export function applyContextPruningDefaults(cfg: OpenClawConfig): OpenClawConfig {
  if (!cfg.agents?.defaults) {
    return cfg;
  }
  if (!hasAnthropicDefaultSignal(cfg, process.env)) {
    return cfg;
  }
  return (
    applyProviderConfigDefaultsForConfig({
      provider: "anthropic",
      config: cfg,
      env: process.env,
    }) ?? cfg
  );
}

/**
 * 应用压缩默认值
 * 如果未设置 compaction.mode，则默认为 "safeguard"
 * @param cfg - OpenClaw 配置对象
 * @returns 应用默认值后的配置对象
 */
export function applyCompactionDefaults(cfg: OpenClawConfig): OpenClawConfig {
  const defaults = cfg.agents?.defaults;
  if (!defaults) {
    return cfg;
  }
  const compaction = defaults?.compaction;
  if (compaction?.mode) {
    return cfg;
  }

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...defaults,
        compaction: {
          ...compaction,
          mode: "safeguard",
        },
      },
    },
  };
}

/**
 * 重置会话默认值警告状态（仅用于测试）
 * 将警告状态重置为未警告状态
 */
export function resetSessionDefaultsWarningForTests() {
  defaultWarnState = { warned: false };
}
