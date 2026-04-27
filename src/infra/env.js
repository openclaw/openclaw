import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
let log = null;
const loggedEnv = new Set();
function getLog() {
    if (!log) {
        log = createSubsystemLogger("env");
    }
    return log;
}
function formatEnvValue(value, redact) {
    if (redact) {
        return "<redacted>";
    }
    const singleLine = value.replace(/\s+/g, " ").trim();
    if (singleLine.length <= 160) {
        return singleLine;
    }
    return `${singleLine.slice(0, 160)}…`;
}
export function logAcceptedEnvOption(option) {
    if (process.env.VITEST || process.env.NODE_ENV === "test") {
        return;
    }
    if (loggedEnv.has(option.key)) {
        return;
    }
    const rawValue = option.value ?? process.env[option.key];
    if (!rawValue || !rawValue.trim()) {
        return;
    }
    loggedEnv.add(option.key);
    getLog().info(`env: ${option.key}=${formatEnvValue(rawValue, option.redact)} (${option.description})`);
}
export function normalizeZaiEnv() {
    if (!process.env.ZAI_API_KEY?.trim() && process.env.Z_AI_API_KEY?.trim()) {
        process.env.ZAI_API_KEY = process.env.Z_AI_API_KEY;
    }
}
export function isTruthyEnvValue(value) {
    if (typeof value !== "string") {
        return false;
    }
    switch (normalizeLowercaseStringOrEmpty(value)) {
        case "1":
        case "on":
        case "true":
        case "yes":
            return true;
        default:
            return false;
    }
}
export function isVitestRuntimeEnv(env = process.env) {
    return (env.VITEST === "true" ||
        env.VITEST === "1" ||
        env.VITEST_POOL_ID !== undefined ||
        env.VITEST_WORKER_ID !== undefined ||
        env.NODE_ENV === "test");
}
export function normalizeEnv() {
    normalizeZaiEnv();
}
