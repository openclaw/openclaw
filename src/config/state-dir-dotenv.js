import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { isDangerousHostEnvOverrideVarName, isDangerousHostEnvVarName, normalizeEnvVarKey, } from "../infra/host-env-security.js";
import { collectConfigServiceEnvVars } from "./config-env-vars.js";
import { resolveStateDir } from "./paths.js";
function isBlockedServiceEnvVar(key) {
    return isDangerousHostEnvVarName(key) || isDangerousHostEnvOverrideVarName(key);
}
function parseStateDirDotEnvContent(content) {
    const parsed = dotenv.parse(content);
    const entries = {};
    for (const [rawKey, value] of Object.entries(parsed)) {
        if (!value?.trim()) {
            continue;
        }
        const key = normalizeEnvVarKey(rawKey, { portable: true });
        if (!key) {
            continue;
        }
        if (isBlockedServiceEnvVar(key)) {
            continue;
        }
        entries[key] = value;
    }
    return entries;
}
export function readStateDirDotEnvVarsFromStateDir(stateDir) {
    const dotEnvPath = path.join(stateDir, ".env");
    try {
        return parseStateDirDotEnvContent(fs.readFileSync(dotEnvPath, "utf8"));
    }
    catch {
        return {};
    }
}
/**
 * Read and parse `~/.openclaw/.env` (or `$OPENCLAW_STATE_DIR/.env`), returning
 * a filtered record of key-value pairs suitable for embedding in a service
 * environment (LaunchAgent plist, systemd unit, Scheduled Task).
 */
export function readStateDirDotEnvVars(env) {
    const stateDir = resolveStateDir(env);
    return readStateDirDotEnvVarsFromStateDir(stateDir);
}
/**
 * Durable service env sources survive beyond the invoking shell and are safe to
 * persist into gateway install metadata.
 *
 * Precedence:
 * 1. state-dir `.env` file vars
 * 2. config service env vars
 */
export function collectDurableServiceEnvVars(params) {
    return {
        ...readStateDirDotEnvVars(params.env),
        ...collectConfigServiceEnvVars(params.config),
    };
}
