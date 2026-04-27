import { modelKey, normalizeProviderId } from "../../agents/model-selection-normalize.js";
import { buildAllowedModelSetWithFallbacks, resolveModelRefFromString, } from "../../agents/model-selection-shared.js";
import { resolveAgentModelFallbackValues } from "../../config/model-input.js";
import { applyModelOverrideToSessionEntry } from "../../sessions/model-overrides.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { resolveModelDirectiveSelection, } from "./model-selection-directive.js";
function splitBody(body) {
    const tokens = body.split(/\s+/).filter(Boolean);
    return {
        tokens,
        first: tokens[0],
        second: tokens[1],
        rest: tokens.slice(2),
    };
}
async function loadResetModelCatalog(cfg) {
    const { loadModelCatalog } = await import("../../agents/model-catalog.js");
    return loadModelCatalog({ config: cfg });
}
async function resolveResetFallbackModels(params) {
    if (params.agentId) {
        const { resolveAgentModelFallbacksOverride } = await import("../../agents/agent-scope.js");
        const override = resolveAgentModelFallbacksOverride(params.cfg, params.agentId);
        if (override !== undefined) {
            return override;
        }
    }
    return resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model);
}
function buildSelectionFromExplicit(params) {
    const resolved = resolveModelRefFromString({
        raw: params.raw,
        defaultProvider: params.defaultProvider,
        aliasIndex: params.aliasIndex,
    });
    if (!resolved) {
        return undefined;
    }
    const key = modelKey(resolved.ref.provider, resolved.ref.model);
    if (params.allowedModelKeys.size > 0 && !params.allowedModelKeys.has(key)) {
        return undefined;
    }
    const isDefault = resolved.ref.provider === params.defaultProvider && resolved.ref.model === params.defaultModel;
    return {
        provider: resolved.ref.provider,
        model: resolved.ref.model,
        isDefault,
        ...(resolved.alias ? { alias: resolved.alias } : undefined),
    };
}
function applySelectionToSession(params) {
    const { selection, sessionEntry, sessionStore, sessionKey, storePath } = params;
    if (!sessionEntry || !sessionStore || !sessionKey) {
        return;
    }
    const { updated } = applyModelOverrideToSessionEntry({
        entry: sessionEntry,
        selection,
    });
    if (!updated) {
        return;
    }
    sessionStore[sessionKey] = sessionEntry;
    if (storePath) {
        void import("../../config/sessions.js")
            .then(({ updateSessionStore }) => updateSessionStore(storePath, (store) => {
            store[sessionKey] = sessionEntry;
        }))
            .catch(() => {
            // Ignore persistence errors; session still proceeds.
        });
    }
}
export async function applyResetModelOverride(params) {
    if (!params.resetTriggered) {
        return {};
    }
    const rawBody = normalizeOptionalString(params.bodyStripped);
    if (!rawBody) {
        return {};
    }
    const { tokens, first, second } = splitBody(rawBody);
    if (!first) {
        return {};
    }
    const catalog = params.modelCatalog ?? (await loadResetModelCatalog(params.cfg));
    const allowed = buildAllowedModelSetWithFallbacks({
        cfg: params.cfg,
        catalog,
        defaultProvider: params.defaultProvider,
        defaultModel: params.defaultModel,
        fallbackModels: await resolveResetFallbackModels({
            cfg: params.cfg,
            agentId: params.agentId,
        }),
    });
    const allowedModelKeys = allowed.allowedKeys;
    if (allowedModelKeys.size === 0) {
        return {};
    }
    const providers = new Set();
    for (const key of allowedModelKeys) {
        const slash = key.indexOf("/");
        if (slash <= 0) {
            continue;
        }
        providers.add(normalizeProviderId(key.slice(0, slash)));
    }
    const resolveSelection = (raw) => resolveModelDirectiveSelection({
        raw,
        defaultProvider: params.defaultProvider,
        defaultModel: params.defaultModel,
        aliasIndex: params.aliasIndex,
        allowedModelKeys,
    });
    let selection;
    let consumed = 0;
    if (providers.has(normalizeProviderId(first)) && second) {
        const composite = `${normalizeProviderId(first)}/${second}`;
        const resolved = resolveSelection(composite);
        if (resolved.selection) {
            selection = resolved.selection;
            consumed = 2;
        }
    }
    if (!selection) {
        selection = buildSelectionFromExplicit({
            raw: first,
            defaultProvider: params.defaultProvider,
            defaultModel: params.defaultModel,
            aliasIndex: params.aliasIndex,
            allowedModelKeys,
        });
        if (selection) {
            consumed = 1;
        }
    }
    if (!selection) {
        const resolved = resolveSelection(first);
        const allowFuzzy = providers.has(normalizeProviderId(first)) || first.trim().length >= 6;
        if (allowFuzzy) {
            selection = resolved.selection;
            if (selection) {
                consumed = 1;
            }
        }
    }
    if (!selection) {
        return {};
    }
    const cleanedBody = tokens.slice(consumed).join(" ").trim();
    params.sessionCtx.BodyStripped = cleanedBody;
    params.sessionCtx.BodyForCommands = cleanedBody;
    applySelectionToSession({
        selection,
        sessionEntry: params.sessionEntry,
        sessionStore: params.sessionStore,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
    });
    return { selection, cleanedBody };
}
