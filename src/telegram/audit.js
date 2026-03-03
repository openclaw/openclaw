import { isRecord } from "../utils.js";
const TELEGRAM_API_BASE = "https://api.telegram.org";
export function collectTelegramUnmentionedGroupIds(groups) {
    if (!groups || typeof groups !== "object") {
        return {
            groupIds: [],
            unresolvedGroups: 0,
            hasWildcardUnmentionedGroups: false,
        };
    }
    const hasWildcardUnmentionedGroups = Boolean(groups["*"]?.requireMention === false) && groups["*"]?.enabled !== false;
    const groupIds = [];
    let unresolvedGroups = 0;
    for (const [key, value] of Object.entries(groups)) {
        if (key === "*") {
            continue;
        }
        if (!value || typeof value !== "object") {
            continue;
        }
        if (value.enabled === false) {
            continue;
        }
        if (value.requireMention !== false) {
            continue;
        }
        const id = String(key).trim();
        if (!id) {
            continue;
        }
        if (/^-?\d+$/.test(id)) {
            groupIds.push(id);
        }
        else {
            unresolvedGroups += 1;
        }
    }
    groupIds.sort((a, b) => a.localeCompare(b));
    return { groupIds, unresolvedGroups, hasWildcardUnmentionedGroups };
}
export async function auditTelegramGroupMembership(params) {
    const started = Date.now();
    const token = params.token?.trim() ?? "";
    if (!token || params.groupIds.length === 0) {
        return {
            ok: true,
            checkedGroups: 0,
            unresolvedGroups: 0,
            hasWildcardUnmentionedGroups: false,
            groups: [],
            elapsedMs: Date.now() - started,
        };
    }
    // Lazy import to avoid pulling `undici` (ProxyAgent) into cold-path callers that only need
    // `collectTelegramUnmentionedGroupIds` (e.g. config audits).
    const fetcher = params.proxyUrl
        ? (await import("./proxy.js")).makeProxyFetch(params.proxyUrl)
        : fetch;
    const { fetchWithTimeout } = await import("../utils/fetch-timeout.js");
    const base = `${TELEGRAM_API_BASE}/bot${token}`;
    const groups = [];
    for (const chatId of params.groupIds) {
        try {
            const url = `${base}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${encodeURIComponent(String(params.botId))}`;
            const res = await fetchWithTimeout(url, {}, params.timeoutMs, fetcher);
            const json = (await res.json());
            if (!res.ok || !isRecord(json) || !json.ok) {
                const desc = isRecord(json) && !json.ok && typeof json.description === "string"
                    ? json.description
                    : `getChatMember failed (${res.status})`;
                groups.push({
                    chatId,
                    ok: false,
                    status: null,
                    error: desc,
                    matchKey: chatId,
                    matchSource: "id",
                });
                continue;
            }
            const status = isRecord(json.result)
                ? (json.result.status ?? null)
                : null;
            const ok = status === "creator" || status === "administrator" || status === "member";
            groups.push({
                chatId,
                ok,
                status,
                error: ok ? null : "bot not in group",
                matchKey: chatId,
                matchSource: "id",
            });
        }
        catch (err) {
            groups.push({
                chatId,
                ok: false,
                status: null,
                error: err instanceof Error ? err.message : String(err),
                matchKey: chatId,
                matchSource: "id",
            });
        }
    }
    return {
        ok: groups.every((g) => g.ok),
        checkedGroups: groups.length,
        unresolvedGroups: 0,
        hasWildcardUnmentionedGroups: false,
        groups,
        elapsedMs: Date.now() - started,
    };
}
