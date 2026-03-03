import { buildProfileQuery, withBaseUrl } from "./client-actions-url.js";
import { fetchBrowserJson } from "./client-fetch.js";
function buildQuerySuffix(params) {
    const query = new URLSearchParams();
    for (const [key, value] of params) {
        if (typeof value === "boolean") {
            query.set(key, String(value));
            continue;
        }
        if (typeof value === "string" && value.length > 0) {
            query.set(key, value);
        }
    }
    const encoded = query.toString();
    return encoded.length > 0 ? `?${encoded}` : "";
}
export async function browserConsoleMessages(baseUrl, opts = {}) {
    const suffix = buildQuerySuffix([
        ["level", opts.level],
        ["targetId", opts.targetId],
        ["profile", opts.profile],
    ]);
    return await fetchBrowserJson(withBaseUrl(baseUrl, `/console${suffix}`), { timeoutMs: 20000 });
}
export async function browserPdfSave(baseUrl, opts = {}) {
    const q = buildProfileQuery(opts.profile);
    return await fetchBrowserJson(withBaseUrl(baseUrl, `/pdf${q}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId: opts.targetId }),
        timeoutMs: 20000,
    });
}
export async function browserPageErrors(baseUrl, opts = {}) {
    const suffix = buildQuerySuffix([
        ["targetId", opts.targetId],
        ["clear", typeof opts.clear === "boolean" ? opts.clear : undefined],
        ["profile", opts.profile],
    ]);
    return await fetchBrowserJson(withBaseUrl(baseUrl, `/errors${suffix}`), { timeoutMs: 20000 });
}
export async function browserRequests(baseUrl, opts = {}) {
    const suffix = buildQuerySuffix([
        ["targetId", opts.targetId],
        ["filter", opts.filter],
        ["clear", typeof opts.clear === "boolean" ? opts.clear : undefined],
        ["profile", opts.profile],
    ]);
    return await fetchBrowserJson(withBaseUrl(baseUrl, `/requests${suffix}`), { timeoutMs: 20000 });
}
export async function browserTraceStart(baseUrl, opts = {}) {
    const q = buildProfileQuery(opts.profile);
    return await fetchBrowserJson(withBaseUrl(baseUrl, `/trace/start${q}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            targetId: opts.targetId,
            screenshots: opts.screenshots,
            snapshots: opts.snapshots,
            sources: opts.sources,
        }),
        timeoutMs: 20000,
    });
}
export async function browserTraceStop(baseUrl, opts = {}) {
    const q = buildProfileQuery(opts.profile);
    return await fetchBrowserJson(withBaseUrl(baseUrl, `/trace/stop${q}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId: opts.targetId, path: opts.path }),
        timeoutMs: 20000,
    });
}
export async function browserHighlight(baseUrl, opts) {
    const q = buildProfileQuery(opts.profile);
    return await fetchBrowserJson(withBaseUrl(baseUrl, `/highlight${q}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId: opts.targetId, ref: opts.ref }),
        timeoutMs: 20000,
    });
}
export async function browserResponseBody(baseUrl, opts) {
    const q = buildProfileQuery(opts.profile);
    return await fetchBrowserJson(withBaseUrl(baseUrl, `/response/body${q}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            targetId: opts.targetId,
            url: opts.url,
            timeoutMs: opts.timeoutMs,
            maxChars: opts.maxChars,
        }),
        timeoutMs: 20000,
    });
}
