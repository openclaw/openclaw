import { resolveFetch } from "./fetch.js";
import { resolveProviderAuths } from "./provider-usage.auth.js";
import { fetchClaudeUsage, fetchCodexUsage, fetchCopilotUsage, fetchGeminiUsage, fetchMinimaxUsage, fetchZaiUsage, } from "./provider-usage.fetch.js";
import { DEFAULT_TIMEOUT_MS, ignoredErrors, PROVIDER_LABELS, usageProviders, withTimeout, } from "./provider-usage.shared.js";
export async function loadProviderUsageSummary(opts = {}) {
    const now = opts.now ?? Date.now();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fetchFn = resolveFetch(opts.fetch);
    if (!fetchFn) {
        throw new Error("fetch is not available");
    }
    const auths = await resolveProviderAuths({
        providers: opts.providers ?? usageProviders,
        auth: opts.auth,
        agentDir: opts.agentDir,
    });
    if (auths.length === 0) {
        return { updatedAt: now, providers: [] };
    }
    const tasks = auths.map((auth) => withTimeout((async () => {
        switch (auth.provider) {
            case "anthropic":
                return await fetchClaudeUsage(auth.token, timeoutMs, fetchFn);
            case "github-copilot":
                return await fetchCopilotUsage(auth.token, timeoutMs, fetchFn);
            case "google-gemini-cli":
                return await fetchGeminiUsage(auth.token, timeoutMs, fetchFn, auth.provider);
            case "openai-codex":
                return await fetchCodexUsage(auth.token, auth.accountId, timeoutMs, fetchFn);
            case "minimax":
                return await fetchMinimaxUsage(auth.token, timeoutMs, fetchFn);
            case "xiaomi":
                return {
                    provider: "xiaomi",
                    displayName: PROVIDER_LABELS.xiaomi,
                    windows: [],
                };
            case "zai":
                return await fetchZaiUsage(auth.token, timeoutMs, fetchFn);
            default:
                return {
                    provider: auth.provider,
                    displayName: PROVIDER_LABELS[auth.provider],
                    windows: [],
                    error: "Unsupported provider",
                };
        }
    })(), timeoutMs + 1000, {
        provider: auth.provider,
        displayName: PROVIDER_LABELS[auth.provider],
        windows: [],
        error: "Timeout",
    }));
    const snapshots = await Promise.all(tasks);
    const providers = snapshots.filter((entry) => {
        if (entry.windows.length > 0) {
            return true;
        }
        if (!entry.error) {
            return true;
        }
        return !ignoredErrors.has(entry.error);
    });
    return { updatedAt: now, providers };
}
