import { createSubsystemLogger } from "../logging/subsystem.js";
import { parseBooleanValue } from "../utils/boolean.js";
const log = createSubsystemLogger("env");
const loggedEnv = new Set();
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
    log.info(`env: ${option.key}=${formatEnvValue(rawValue, option.redact)} (${option.description})`);
}
export function normalizeZaiEnv() {
    if (!process.env.ZAI_API_KEY?.trim() && process.env.Z_AI_API_KEY?.trim()) {
        process.env.ZAI_API_KEY = process.env.Z_AI_API_KEY;
    }
}
export function isTruthyEnvValue(value) {
    return parseBooleanValue(value) === true;
}
export function normalizeEnv() {
    normalizeZaiEnv();
}
