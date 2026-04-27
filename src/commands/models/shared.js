import { listAgentIds } from "../../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { buildModelAliasIndex, legacyModelKey, modelKey, parseModelRef, resolveModelRefFromString, } from "../../agents/model-selection.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { readConfigFileSnapshot, replaceConfigFile, } from "../../config/config.js";
import { formatConfigIssueLines } from "../../config/issue-format.js";
import { toAgentModelListLike } from "../../config/model-input.js";
import { normalizeAgentId } from "../../routing/session-key.js";
export { normalizeAlias } from "./alias-name.js";
export { isLocalBaseUrl } from "./list.local-url.js";
export const ensureFlagCompatibility = (opts) => {
    if (opts.json && opts.plain) {
        throw new Error("Choose either --json or --plain, not both.");
    }
};
export const formatTokenK = (value) => {
    if (!value || !Number.isFinite(value)) {
        return "-";
    }
    if (value < 1024) {
        return `${Math.round(value)}`;
    }
    return `${Math.round(value / 1024)}k`;
};
export const formatMs = (value) => {
    if (value === null || value === undefined) {
        return "-";
    }
    if (!Number.isFinite(value)) {
        return "-";
    }
    if (value < 1000) {
        return `${Math.round(value)}ms`;
    }
    return `${Math.round(value / 100) / 10}s`;
};
export async function loadValidConfigOrThrow() {
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
        const issues = formatConfigIssueLines(snapshot.issues, "-").join("\n");
        throw new Error(`Invalid config at ${snapshot.path}\n${issues}`);
    }
    return snapshot.runtimeConfig ?? snapshot.config;
}
export async function updateConfig(mutator) {
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
        const issues = formatConfigIssueLines(snapshot.issues, "-").join("\n");
        throw new Error(`Invalid config at ${snapshot.path}\n${issues}`);
    }
    const next = mutator(structuredClone(snapshot.sourceConfig ?? snapshot.config));
    await replaceConfigFile({
        nextConfig: next,
        baseHash: snapshot.hash,
    });
    return next;
}
export function resolveModelTarget(params) {
    const aliasIndex = buildModelAliasIndex({
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
    });
    const resolved = resolveModelRefFromString({
        raw: params.raw,
        defaultProvider: DEFAULT_PROVIDER,
        aliasIndex,
    });
    if (!resolved) {
        throw new Error(`Invalid model reference: ${params.raw}`);
    }
    return resolved.ref;
}
export function resolveModelKeysFromEntries(params) {
    const aliasIndex = buildModelAliasIndex({
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
    });
    return params.entries
        .map((entry) => resolveModelRefFromString({
        raw: entry,
        defaultProvider: DEFAULT_PROVIDER,
        aliasIndex,
    }))
        .filter((entry) => Boolean(entry))
        .map((entry) => modelKey(entry.ref.provider, entry.ref.model));
}
export function buildAllowlistSet(cfg) {
    const allowed = new Set();
    const models = cfg.agents?.defaults?.models ?? {};
    for (const raw of Object.keys(models)) {
        const parsed = parseModelRef(raw, DEFAULT_PROVIDER);
        if (!parsed) {
            continue;
        }
        allowed.add(modelKey(parsed.provider, parsed.model));
    }
    return allowed;
}
export function resolveKnownAgentId(params) {
    const raw = params.rawAgentId?.trim();
    if (!raw) {
        return undefined;
    }
    const agentId = normalizeAgentId(raw);
    const knownAgents = listAgentIds(params.cfg);
    if (!knownAgents.includes(agentId)) {
        throw new Error(`Unknown agent id "${raw}". Use "${formatCliCommand("openclaw agents list")}" to see configured agents.`);
    }
    return agentId;
}
export function upsertCanonicalModelConfigEntry(models, params) {
    const key = modelKey(params.provider, params.model);
    const legacyKey = legacyModelKey(params.provider, params.model);
    if (!models[key]) {
        if (legacyKey && models[legacyKey]) {
            models[key] = models[legacyKey];
        }
        else {
            models[key] = {};
        }
    }
    if (legacyKey) {
        delete models[legacyKey];
    }
    return key;
}
export function mergePrimaryFallbackConfig(existing, patch) {
    const base = existing && typeof existing === "object" ? existing : undefined;
    const next = { ...base };
    if (patch.primary !== undefined) {
        next.primary = patch.primary;
    }
    if (patch.fallbacks !== undefined) {
        next.fallbacks = patch.fallbacks;
    }
    return next;
}
export function applyDefaultModelPrimaryUpdate(params) {
    const resolved = resolveModelTarget({ raw: params.modelRaw, cfg: params.cfg });
    const nextModels = {
        ...params.cfg.agents?.defaults?.models,
    };
    const key = upsertCanonicalModelConfigEntry(nextModels, resolved);
    const defaults = params.cfg.agents?.defaults ?? {};
    const existing = toAgentModelListLike(defaults[params.field]);
    return {
        ...params.cfg,
        agents: {
            ...params.cfg.agents,
            defaults: {
                ...defaults,
                [params.field]: mergePrimaryFallbackConfig(existing, { primary: key }),
                models: nextModels,
            },
        },
    };
}
export { modelKey };
export { DEFAULT_MODEL, DEFAULT_PROVIDER };
/**
 * Model key format: "provider/model"
 *
 * The model key is displayed in `/model status` and used to reference models.
 * When using `/model <key>`, use the exact format shown (e.g., "openrouter/moonshotai/kimi-k2").
 *
 * For providers with hierarchical model IDs (e.g., OpenRouter), the model ID may include
 * sub-providers (e.g., "moonshotai/kimi-k2"), resulting in a key like "openrouter/moonshotai/kimi-k2".
 */
