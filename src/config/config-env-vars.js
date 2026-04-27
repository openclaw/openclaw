import { isDangerousHostEnvOverrideVarName, isDangerousHostEnvVarName, normalizeEnvVarKey, } from "../infra/host-env-security.js";
import { containsEnvVarReference } from "./env-substitution.js";
function isBlockedConfigEnvVar(key) {
    return isDangerousHostEnvVarName(key) || isDangerousHostEnvOverrideVarName(key);
}
function collectConfigEnvVarsByTarget(cfg) {
    const envConfig = cfg?.env;
    if (!envConfig) {
        return {};
    }
    const entries = {};
    if (envConfig.vars) {
        for (const [rawKey, value] of Object.entries(envConfig.vars)) {
            if (!value) {
                continue;
            }
            const key = normalizeEnvVarKey(rawKey, { portable: true });
            if (!key) {
                continue;
            }
            if (isBlockedConfigEnvVar(key)) {
                continue;
            }
            entries[key] = value;
        }
    }
    for (const [rawKey, value] of Object.entries(envConfig)) {
        if (rawKey === "shellEnv" || rawKey === "vars") {
            continue;
        }
        if (typeof value !== "string" || !value.trim()) {
            continue;
        }
        const key = normalizeEnvVarKey(rawKey, { portable: true });
        if (!key) {
            continue;
        }
        if (isBlockedConfigEnvVar(key)) {
            continue;
        }
        entries[key] = value;
    }
    return entries;
}
export function collectConfigRuntimeEnvVars(cfg) {
    return collectConfigEnvVarsByTarget(cfg);
}
export function collectConfigServiceEnvVars(cfg) {
    return collectConfigEnvVarsByTarget(cfg);
}
/** @deprecated Use `collectConfigRuntimeEnvVars` or `collectConfigServiceEnvVars`. */
export function collectConfigEnvVars(cfg) {
    return collectConfigRuntimeEnvVars(cfg);
}
export function createConfigRuntimeEnv(cfg, baseEnv = process.env) {
    const env = { ...baseEnv };
    applyConfigEnvVars(cfg, env);
    return env;
}
export function applyConfigEnvVars(cfg, env = process.env) {
    const entries = collectConfigRuntimeEnvVars(cfg);
    for (const [key, value] of Object.entries(entries)) {
        if (env[key]?.trim()) {
            continue;
        }
        // Skip values containing unresolved ${VAR} references — applyConfigEnvVars runs
        // before env substitution, so these would pollute process.env with literal placeholders
        // (e.g. process.env.OPENCLAW_GATEWAY_TOKEN = "${VAULT_TOKEN}") which downstream auth
        // resolution would accept as valid credentials.
        if (containsEnvVarReference(value)) {
            continue;
        }
        env[key] = value;
    }
}
