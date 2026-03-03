import { normalizeProviderId } from "../agents/model-selection.js";
export const DEFAULT_TIMEOUT_MS = 5000;
export const PROVIDER_LABELS = {
    anthropic: "Claude",
    "github-copilot": "Copilot",
    "google-gemini-cli": "Gemini",
    minimax: "MiniMax",
    "openai-codex": "Codex",
    xiaomi: "Xiaomi",
    zai: "z.ai",
};
export const usageProviders = [
    "anthropic",
    "github-copilot",
    "google-gemini-cli",
    "minimax",
    "openai-codex",
    "xiaomi",
    "zai",
];
export function resolveUsageProviderId(provider) {
    if (!provider) {
        return undefined;
    }
    const normalized = normalizeProviderId(provider);
    return usageProviders.includes(normalized)
        ? normalized
        : undefined;
}
export const ignoredErrors = new Set([
    "No credentials",
    "No token",
    "No API key",
    "Not logged in",
    "No auth",
]);
export const clampPercent = (value) => Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
export const withTimeout = async (work, ms, fallback) => {
    let timeout;
    try {
        return await Promise.race([
            work,
            new Promise((resolve) => {
                timeout = setTimeout(() => resolve(fallback), ms);
            }),
        ]);
    }
    finally {
        if (timeout) {
            clearTimeout(timeout);
        }
    }
};
