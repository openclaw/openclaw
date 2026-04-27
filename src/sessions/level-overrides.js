import { normalizeTraceLevel, normalizeVerboseLevel, } from "../auto-reply/thinking.js";
export function parseVerboseOverride(raw) {
    if (raw === null) {
        return { ok: true, value: null };
    }
    if (raw === undefined) {
        return { ok: true, value: undefined };
    }
    if (typeof raw !== "string") {
        return { ok: false, error: 'invalid verboseLevel (use "on"|"off")' };
    }
    const normalized = normalizeVerboseLevel(raw);
    if (!normalized) {
        return { ok: false, error: 'invalid verboseLevel (use "on"|"off")' };
    }
    return { ok: true, value: normalized };
}
export function applyVerboseOverride(entry, level) {
    if (level === undefined) {
        return;
    }
    if (level === null) {
        delete entry.verboseLevel;
        return;
    }
    entry.verboseLevel = level;
}
export function parseTraceOverride(raw) {
    if (raw === null) {
        return { ok: true, value: null };
    }
    if (raw === undefined) {
        return { ok: true, value: undefined };
    }
    if (typeof raw !== "string") {
        return { ok: false, error: 'invalid traceLevel (use "on"|"off"|"raw")' };
    }
    const normalized = normalizeTraceLevel(raw);
    if (!normalized) {
        return { ok: false, error: 'invalid traceLevel (use "on"|"off"|"raw")' };
    }
    return { ok: true, value: normalized };
}
export function applyTraceOverride(entry, level) {
    if (level === undefined) {
        return;
    }
    if (level === null) {
        delete entry.traceLevel;
        return;
    }
    entry.traceLevel = level;
}
