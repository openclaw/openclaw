const DIAGNOSTICS_ENV = "OPENCLAW_DIAGNOSTICS";
function normalizeFlag(value) {
    return value.trim().toLowerCase();
}
function parseEnvFlags(raw) {
    if (!raw) {
        return [];
    }
    const trimmed = raw.trim();
    if (!trimmed) {
        return [];
    }
    const lowered = trimmed.toLowerCase();
    if (["0", "false", "off", "none"].includes(lowered)) {
        return [];
    }
    if (["1", "true", "all", "*"].includes(lowered)) {
        return ["*"];
    }
    return trimmed
        .split(/[,\s]+/)
        .map(normalizeFlag)
        .filter(Boolean);
}
function uniqueFlags(flags) {
    const seen = new Set();
    const out = [];
    for (const flag of flags) {
        const normalized = normalizeFlag(flag);
        if (!normalized || seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        out.push(normalized);
    }
    return out;
}
export function resolveDiagnosticFlags(cfg, env = process.env) {
    const configFlags = Array.isArray(cfg?.diagnostics?.flags) ? cfg?.diagnostics?.flags : [];
    const envFlags = parseEnvFlags(env[DIAGNOSTICS_ENV]);
    return uniqueFlags([...configFlags, ...envFlags]);
}
export function matchesDiagnosticFlag(flag, enabledFlags) {
    const target = normalizeFlag(flag);
    if (!target) {
        return false;
    }
    for (const raw of enabledFlags) {
        const enabled = normalizeFlag(raw);
        if (!enabled) {
            continue;
        }
        if (enabled === "*" || enabled === "all") {
            return true;
        }
        if (enabled.endsWith(".*")) {
            const prefix = enabled.slice(0, -2);
            if (target === prefix || target.startsWith(`${prefix}.`)) {
                return true;
            }
        }
        if (enabled.endsWith("*")) {
            const prefix = enabled.slice(0, -1);
            if (target.startsWith(prefix)) {
                return true;
            }
        }
        if (enabled === target) {
            return true;
        }
    }
    return false;
}
export function isDiagnosticFlagEnabled(flag, cfg, env = process.env) {
    const flags = resolveDiagnosticFlags(cfg, env);
    return matchesDiagnosticFlag(flag, flags);
}
