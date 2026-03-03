import { isPlainObject } from "../utils.js";
import { parseConfigPath, setConfigValueAtPath, unsetConfigValueAtPath } from "./config-paths.js";
import { isBlockedObjectKey } from "./prototype-keys.js";
let overrides = {};
function sanitizeOverrideValue(value, seen = new WeakSet()) {
    if (Array.isArray(value)) {
        return value.map((entry) => sanitizeOverrideValue(entry, seen));
    }
    if (!isPlainObject(value)) {
        return value;
    }
    if (seen.has(value)) {
        return {};
    }
    seen.add(value);
    const sanitized = {};
    for (const [key, entry] of Object.entries(value)) {
        if (entry === undefined || isBlockedObjectKey(key)) {
            continue;
        }
        sanitized[key] = sanitizeOverrideValue(entry, seen);
    }
    seen.delete(value);
    return sanitized;
}
function mergeOverrides(base, override) {
    if (!isPlainObject(base) || !isPlainObject(override)) {
        return override;
    }
    const next = { ...base };
    for (const [key, value] of Object.entries(override)) {
        if (value === undefined || isBlockedObjectKey(key)) {
            continue;
        }
        next[key] = mergeOverrides(base[key], value);
    }
    return next;
}
export function getConfigOverrides() {
    return overrides;
}
export function resetConfigOverrides() {
    overrides = {};
}
export function setConfigOverride(pathRaw, value) {
    const parsed = parseConfigPath(pathRaw);
    if (!parsed.ok || !parsed.path) {
        return { ok: false, error: parsed.error ?? "Invalid path." };
    }
    setConfigValueAtPath(overrides, parsed.path, sanitizeOverrideValue(value));
    return { ok: true };
}
export function unsetConfigOverride(pathRaw) {
    const parsed = parseConfigPath(pathRaw);
    if (!parsed.ok || !parsed.path) {
        return {
            ok: false,
            removed: false,
            error: parsed.error ?? "Invalid path.",
        };
    }
    const removed = unsetConfigValueAtPath(overrides, parsed.path);
    return { ok: true, removed };
}
export function applyConfigOverrides(cfg) {
    if (!overrides || Object.keys(overrides).length === 0) {
        return cfg;
    }
    return mergeOverrides(cfg, overrides);
}
