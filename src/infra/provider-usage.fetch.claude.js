import { buildUsageHttpErrorSnapshot, fetchJson } from "./provider-usage.fetch.shared.js";
import { clampPercent, PROVIDER_LABELS } from "./provider-usage.shared.js";
function buildClaudeUsageWindows(data) {
    const windows = [];
    if (data.five_hour?.utilization !== undefined) {
        windows.push({
            label: "5h",
            usedPercent: clampPercent(data.five_hour.utilization),
            resetAt: data.five_hour.resets_at ? new Date(data.five_hour.resets_at).getTime() : undefined,
        });
    }
    if (data.seven_day?.utilization !== undefined) {
        windows.push({
            label: "Week",
            usedPercent: clampPercent(data.seven_day.utilization),
            resetAt: data.seven_day.resets_at ? new Date(data.seven_day.resets_at).getTime() : undefined,
        });
    }
    const modelWindow = data.seven_day_sonnet || data.seven_day_opus;
    if (modelWindow?.utilization !== undefined) {
        windows.push({
            label: data.seven_day_sonnet ? "Sonnet" : "Opus",
            usedPercent: clampPercent(modelWindow.utilization),
        });
    }
    return windows;
}
function resolveClaudeWebSessionKey() {
    const direct = process.env.CLAUDE_AI_SESSION_KEY?.trim() ?? process.env.CLAUDE_WEB_SESSION_KEY?.trim();
    if (direct?.startsWith("sk-ant-")) {
        return direct;
    }
    const cookieHeader = process.env.CLAUDE_WEB_COOKIE?.trim();
    if (!cookieHeader) {
        return undefined;
    }
    const stripped = cookieHeader.replace(/^cookie:\s*/i, "");
    const match = stripped.match(/(?:^|;\s*)sessionKey=([^;\s]+)/i);
    const value = match?.[1]?.trim();
    return value?.startsWith("sk-ant-") ? value : undefined;
}
async function fetchClaudeWebUsage(sessionKey, timeoutMs, fetchFn) {
    const headers = {
        Cookie: `sessionKey=${sessionKey}`,
        Accept: "application/json",
    };
    const orgRes = await fetchJson("https://claude.ai/api/organizations", { headers }, timeoutMs, fetchFn);
    if (!orgRes.ok) {
        return null;
    }
    const orgs = (await orgRes.json());
    const orgId = orgs?.[0]?.uuid?.trim();
    if (!orgId) {
        return null;
    }
    const usageRes = await fetchJson(`https://claude.ai/api/organizations/${orgId}/usage`, { headers }, timeoutMs, fetchFn);
    if (!usageRes.ok) {
        return null;
    }
    const data = (await usageRes.json());
    const windows = buildClaudeUsageWindows(data);
    if (windows.length === 0) {
        return null;
    }
    return {
        provider: "anthropic",
        displayName: PROVIDER_LABELS.anthropic,
        windows,
    };
}
export async function fetchClaudeUsage(token, timeoutMs, fetchFn) {
    const res = await fetchJson("https://api.anthropic.com/api/oauth/usage", {
        headers: {
            Authorization: `Bearer ${token}`,
            "User-Agent": "openclaw",
            Accept: "application/json",
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "oauth-2025-04-20",
        },
    }, timeoutMs, fetchFn);
    if (!res.ok) {
        let message;
        try {
            const data = (await res.json());
            const raw = data?.error?.message;
            if (typeof raw === "string" && raw.trim()) {
                message = raw.trim();
            }
        }
        catch {
            // ignore parse errors
        }
        // Claude Code CLI setup-token yields tokens that can be used for inference, but may not
        // include user:profile scope required by the OAuth usage endpoint. When a claude.ai
        // browser sessionKey is available, fall back to the web API.
        if (res.status === 403 && message?.includes("scope requirement user:profile")) {
            const sessionKey = resolveClaudeWebSessionKey();
            if (sessionKey) {
                const web = await fetchClaudeWebUsage(sessionKey, timeoutMs, fetchFn);
                if (web) {
                    return web;
                }
            }
        }
        return buildUsageHttpErrorSnapshot({
            provider: "anthropic",
            status: res.status,
            message,
        });
    }
    const data = (await res.json());
    const windows = buildClaudeUsageWindows(data);
    return {
        provider: "anthropic",
        displayName: PROVIDER_LABELS.anthropic,
        windows,
    };
}
