import { DEFAULT_CONTEXT_TOKENS } from "../agents/defaults.js";
import { normalizeProviderId, parseModelRef } from "../agents/model-selection.js";
import { DEFAULT_AGENT_MAX_CONCURRENT, DEFAULT_SUBAGENT_MAX_CONCURRENT } from "./agent-limits.js";
import { resolveAgentModelPrimaryValue } from "./model-input.js";
import { DEFAULT_TALK_PROVIDER, normalizeTalkConfig, resolveActiveTalkProviderConfig, resolveTalkApiKey, } from "./talk.js";
let defaultWarnState = { warned: false };
const DEFAULT_MODEL_ALIASES = {
    // Anthropic (pi-ai catalog uses "latest" ids without date suffix)
    opus: "anthropic/claude-opus-4-6",
    sonnet: "anthropic/claude-sonnet-4-6",
    // OpenAI
    gpt: "openai/gpt-5.2",
    "gpt-mini": "openai/gpt-5-mini",
    // Google Gemini (3.x are preview ids in the catalog)
    gemini: "google/gemini-3-pro-preview",
    "gemini-flash": "google/gemini-3-flash-preview",
};
const DEFAULT_MODEL_COST = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
};
const DEFAULT_MODEL_INPUT = ["text"];
const DEFAULT_MODEL_MAX_TOKENS = 8192;
function resolveDefaultProviderApi(providerId, providerApi) {
    if (providerApi) {
        return providerApi;
    }
    return normalizeProviderId(providerId) === "anthropic" ? "anthropic-messages" : undefined;
}
function isPositiveNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function resolveModelCost(raw) {
    return {
        input: typeof raw?.input === "number" ? raw.input : DEFAULT_MODEL_COST.input,
        output: typeof raw?.output === "number" ? raw.output : DEFAULT_MODEL_COST.output,
        cacheRead: typeof raw?.cacheRead === "number" ? raw.cacheRead : DEFAULT_MODEL_COST.cacheRead,
        cacheWrite: typeof raw?.cacheWrite === "number" ? raw.cacheWrite : DEFAULT_MODEL_COST.cacheWrite,
    };
}
function resolveAnthropicDefaultAuthMode(cfg) {
    const profiles = cfg.auth?.profiles ?? {};
    const anthropicProfiles = Object.entries(profiles).filter(([, profile]) => profile?.provider === "anthropic");
    const order = cfg.auth?.order?.anthropic ?? [];
    for (const profileId of order) {
        const entry = profiles[profileId];
        if (!entry || entry.provider !== "anthropic") {
            continue;
        }
        if (entry.mode === "api_key") {
            return "api_key";
        }
        if (entry.mode === "oauth" || entry.mode === "token") {
            return "oauth";
        }
    }
    const hasApiKey = anthropicProfiles.some(([, profile]) => profile?.mode === "api_key");
    const hasOauth = anthropicProfiles.some(([, profile]) => profile?.mode === "oauth" || profile?.mode === "token");
    if (hasApiKey && !hasOauth) {
        return "api_key";
    }
    if (hasOauth && !hasApiKey) {
        return "oauth";
    }
    if (process.env.ANTHROPIC_OAUTH_TOKEN?.trim()) {
        return "oauth";
    }
    if (process.env.ANTHROPIC_API_KEY?.trim()) {
        return "api_key";
    }
    return null;
}
function resolvePrimaryModelRef(raw) {
    if (!raw || typeof raw !== "string") {
        return null;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
        return null;
    }
    const aliasKey = trimmed.toLowerCase();
    return DEFAULT_MODEL_ALIASES[aliasKey] ?? trimmed;
}
export function applyMessageDefaults(cfg) {
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
export function applySessionDefaults(cfg, options = {}) {
    const session = cfg.session;
    if (!session || session.mainKey === undefined) {
        return cfg;
    }
    const trimmed = session.mainKey.trim();
    const warn = options.warn ?? console.warn;
    const warnState = options.warnState ?? defaultWarnState;
    const next = {
        ...cfg,
        session: { ...session, mainKey: "main" },
    };
    if (trimmed && trimmed !== "main" && !warnState.warned) {
        warnState.warned = true;
        warn('session.mainKey is ignored; main session is always "main".');
    }
    return next;
}
export function applyTalkApiKey(config) {
    const normalized = normalizeTalkConfig(config);
    const resolved = resolveTalkApiKey();
    if (!resolved) {
        return normalized;
    }
    const talk = normalized.talk;
    const active = resolveActiveTalkProviderConfig(talk);
    if (active.provider && active.provider !== DEFAULT_TALK_PROVIDER) {
        return normalized;
    }
    const existingProviderApiKey = typeof active.config?.apiKey === "string" ? active.config.apiKey.trim() : "";
    const existingLegacyApiKey = typeof talk?.apiKey === "string" ? talk.apiKey.trim() : "";
    if (existingProviderApiKey || existingLegacyApiKey) {
        return normalized;
    }
    const providerId = active.provider ?? DEFAULT_TALK_PROVIDER;
    const providers = { ...talk?.providers };
    const providerConfig = { ...providers[providerId], apiKey: resolved };
    providers[providerId] = providerConfig;
    const nextTalk = {
        ...talk,
        provider: talk?.provider ?? providerId,
        providers,
        // Keep legacy shape populated during compatibility rollout.
        apiKey: resolved,
    };
    return {
        ...normalized,
        talk: nextTalk,
    };
}
export function applyTalkConfigNormalization(config) {
    return normalizeTalkConfig(config);
}
export function applyModelDefaults(cfg) {
    let mutated = false;
    let nextCfg = cfg;
    const providerConfig = nextCfg.models?.providers;
    if (providerConfig) {
        const nextProviders = { ...providerConfig };
        for (const [providerId, provider] of Object.entries(providerConfig)) {
            const models = provider.models;
            if (!Array.isArray(models) || models.length === 0) {
                continue;
            }
            const providerApi = resolveDefaultProviderApi(providerId, provider.api);
            let nextProvider = provider;
            if (providerApi && provider.api !== providerApi) {
                mutated = true;
                nextProvider = { ...nextProvider, api: providerApi };
            }
            let providerMutated = false;
            const nextModels = models.map((model) => {
                const raw = model;
                let modelMutated = false;
                const reasoning = typeof raw.reasoning === "boolean" ? raw.reasoning : false;
                if (raw.reasoning !== reasoning) {
                    modelMutated = true;
                }
                const input = raw.input ?? [...DEFAULT_MODEL_INPUT];
                if (raw.input === undefined) {
                    modelMutated = true;
                }
                const cost = resolveModelCost(raw.cost);
                const costMutated = !raw.cost ||
                    raw.cost.input !== cost.input ||
                    raw.cost.output !== cost.output ||
                    raw.cost.cacheRead !== cost.cacheRead ||
                    raw.cost.cacheWrite !== cost.cacheWrite;
                if (costMutated) {
                    modelMutated = true;
                }
                const contextWindow = isPositiveNumber(raw.contextWindow)
                    ? raw.contextWindow
                    : DEFAULT_CONTEXT_TOKENS;
                if (raw.contextWindow !== contextWindow) {
                    modelMutated = true;
                }
                const defaultMaxTokens = Math.min(DEFAULT_MODEL_MAX_TOKENS, contextWindow);
                const rawMaxTokens = isPositiveNumber(raw.maxTokens) ? raw.maxTokens : defaultMaxTokens;
                const maxTokens = Math.min(rawMaxTokens, contextWindow);
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
                return {
                    ...raw,
                    reasoning,
                    input,
                    cost,
                    contextWindow,
                    maxTokens,
                    api,
                };
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
    const existingAgent = nextCfg.agents?.defaults;
    if (!existingAgent) {
        return mutated ? nextCfg : cfg;
    }
    const existingModels = existingAgent.models ?? {};
    if (Object.keys(existingModels).length === 0) {
        return mutated ? nextCfg : cfg;
    }
    const nextModels = {
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
export function applyAgentDefaults(cfg) {
    const agents = cfg.agents;
    const defaults = agents?.defaults;
    const hasMax = typeof defaults?.maxConcurrent === "number" && Number.isFinite(defaults.maxConcurrent);
    const hasSubMax = typeof defaults?.subagents?.maxConcurrent === "number" &&
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
export function applyLoggingDefaults(cfg) {
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
export function applyContextPruningDefaults(cfg) {
    const defaults = cfg.agents?.defaults;
    if (!defaults) {
        return cfg;
    }
    const authMode = resolveAnthropicDefaultAuthMode(cfg);
    if (!authMode) {
        return cfg;
    }
    let mutated = false;
    const nextDefaults = { ...defaults };
    const contextPruning = defaults.contextPruning ?? {};
    const heartbeat = defaults.heartbeat ?? {};
    if (defaults.contextPruning?.mode === undefined) {
        nextDefaults.contextPruning = {
            ...contextPruning,
            mode: "cache-ttl",
            ttl: defaults.contextPruning?.ttl ?? "1h",
        };
        mutated = true;
    }
    if (defaults.heartbeat?.every === undefined) {
        nextDefaults.heartbeat = {
            ...heartbeat,
            every: authMode === "oauth" ? "1h" : "30m",
        };
        mutated = true;
    }
    if (authMode === "api_key") {
        const nextModels = defaults.models ? { ...defaults.models } : {};
        let modelsMutated = false;
        const isAnthropicCacheRetentionTarget = (parsed) => Boolean(parsed &&
            (parsed.provider === "anthropic" ||
                (parsed.provider === "amazon-bedrock" &&
                    parsed.model.toLowerCase().includes("anthropic.claude"))));
        for (const [key, entry] of Object.entries(nextModels)) {
            const parsed = parseModelRef(key, "anthropic");
            if (!isAnthropicCacheRetentionTarget(parsed)) {
                continue;
            }
            const current = entry ?? {};
            const params = current.params ?? {};
            if (typeof params.cacheRetention === "string") {
                continue;
            }
            nextModels[key] = {
                ...current,
                params: { ...params, cacheRetention: "short" },
            };
            modelsMutated = true;
        }
        const primary = resolvePrimaryModelRef(resolveAgentModelPrimaryValue(defaults.model) ?? undefined);
        if (primary) {
            const parsedPrimary = parseModelRef(primary, "anthropic");
            if (isAnthropicCacheRetentionTarget(parsedPrimary)) {
                const key = `${parsedPrimary.provider}/${parsedPrimary.model}`;
                const entry = nextModels[key];
                const current = entry ?? {};
                const params = current.params ?? {};
                if (typeof params.cacheRetention !== "string") {
                    nextModels[key] = {
                        ...current,
                        params: { ...params, cacheRetention: "short" },
                    };
                    modelsMutated = true;
                }
            }
        }
        if (modelsMutated) {
            nextDefaults.models = nextModels;
            mutated = true;
        }
    }
    if (!mutated) {
        return cfg;
    }
    return {
        ...cfg,
        agents: {
            ...cfg.agents,
            defaults: nextDefaults,
        },
    };
}
export function applyCompactionDefaults(cfg) {
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
export function resetSessionDefaultsWarningForTests() {
    defaultWarnState = { warned: false };
}
