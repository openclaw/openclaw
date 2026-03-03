import { resolveFetch } from "../infra/fetch.js";
const PLURALKIT_API_BASE = "https://api.pluralkit.me/v2";
export async function fetchPluralKitMessageInfo(params) {
    if (!params.config?.enabled) {
        return null;
    }
    const fetchImpl = resolveFetch(params.fetcher);
    if (!fetchImpl) {
        return null;
    }
    const headers = {};
    if (params.config.token?.trim()) {
        headers.Authorization = params.config.token.trim();
    }
    const res = await fetchImpl(`${PLURALKIT_API_BASE}/messages/${params.messageId}`, {
        headers,
    });
    if (res.status === 404) {
        return null;
    }
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        const detail = text.trim() ? `: ${text.trim()}` : "";
        throw new Error(`PluralKit API failed (${res.status})${detail}`);
    }
    return (await res.json());
}
