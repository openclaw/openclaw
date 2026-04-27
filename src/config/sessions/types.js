import crypto from "node:crypto";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
function isSessionPluginTraceLine(line) {
    const trimmed = line.trim();
    return trimmed.startsWith("🔎 ") || /(?:^|\s)(?:Debug|Trace):/.test(trimmed);
}
function resolveSessionPluginLines(entry, includeLine) {
    return Array.isArray(entry?.pluginDebugEntries)
        ? entry.pluginDebugEntries.flatMap((pluginEntry) => Array.isArray(pluginEntry?.lines)
            ? pluginEntry.lines.filter((line) => typeof line === "string" && line.trim().length > 0 && includeLine(line))
            : [])
        : [];
}
export function resolveSessionPluginStatusLines(entry) {
    return resolveSessionPluginLines(entry, (line) => !isSessionPluginTraceLine(line));
}
export function resolveSessionPluginTraceLines(entry) {
    return resolveSessionPluginLines(entry, isSessionPluginTraceLine);
}
export function normalizeSessionRuntimeModelFields(entry) {
    const normalizedModel = normalizeOptionalString(entry.model);
    const normalizedProvider = normalizeOptionalString(entry.modelProvider);
    let next = entry;
    if (!normalizedModel) {
        if (entry.model !== undefined || entry.modelProvider !== undefined) {
            next = { ...next };
            delete next.model;
            delete next.modelProvider;
        }
        return next;
    }
    if (entry.model !== normalizedModel) {
        if (next === entry) {
            next = { ...next };
        }
        next.model = normalizedModel;
    }
    if (!normalizedProvider) {
        if (entry.modelProvider !== undefined) {
            if (next === entry) {
                next = { ...next };
            }
            delete next.modelProvider;
        }
        return next;
    }
    if (entry.modelProvider !== normalizedProvider) {
        if (next === entry) {
            next = { ...next };
        }
        next.modelProvider = normalizedProvider;
    }
    return next;
}
export function setSessionRuntimeModel(entry, runtime) {
    const provider = runtime.provider.trim();
    const model = runtime.model.trim();
    if (!provider || !model) {
        return false;
    }
    entry.modelProvider = provider;
    entry.model = model;
    return true;
}
function resolveMergedUpdatedAt(existing, patch, options) {
    if (options?.policy === "preserve-activity" && existing) {
        return existing.updatedAt ?? patch.updatedAt ?? options.now ?? Date.now();
    }
    return Math.max(existing?.updatedAt ?? 0, patch.updatedAt ?? 0, options?.now ?? Date.now());
}
export function mergeSessionEntryWithPolicy(existing, patch, options) {
    const sessionId = patch.sessionId ?? existing?.sessionId ?? crypto.randomUUID();
    const updatedAt = resolveMergedUpdatedAt(existing, patch, options);
    if (!existing) {
        return normalizeSessionRuntimeModelFields({ ...patch, sessionId, updatedAt });
    }
    const next = { ...existing, ...patch, sessionId, updatedAt };
    // Guard against stale provider carry-over when callers patch runtime model
    // without also patching runtime provider.
    if (Object.hasOwn(patch, "model") && !Object.hasOwn(patch, "modelProvider")) {
        const patchedModel = normalizeOptionalString(patch.model);
        const existingModel = normalizeOptionalString(existing.model);
        if (patchedModel && patchedModel !== existingModel) {
            delete next.modelProvider;
        }
    }
    return normalizeSessionRuntimeModelFields(next);
}
export function mergeSessionEntry(existing, patch) {
    return mergeSessionEntryWithPolicy(existing, patch);
}
export function mergeSessionEntryPreserveActivity(existing, patch) {
    return mergeSessionEntryWithPolicy(existing, patch, {
        policy: "preserve-activity",
    });
}
export function resolveSessionTotalTokens(entry) {
    const total = entry?.totalTokens;
    if (typeof total !== "number" || !Number.isFinite(total) || total < 0) {
        return undefined;
    }
    return total;
}
export function resolveFreshSessionTotalTokens(entry) {
    const total = resolveSessionTotalTokens(entry);
    if (total === undefined) {
        return undefined;
    }
    if (entry?.totalTokensFresh === false) {
        return undefined;
    }
    return total;
}
export function isSessionTotalTokensFresh(entry) {
    return resolveFreshSessionTotalTokens(entry) !== undefined;
}
export const DEFAULT_RESET_TRIGGER = "/new";
export const DEFAULT_RESET_TRIGGERS = ["/new", "/reset"];
export const DEFAULT_IDLE_MINUTES = 0;
