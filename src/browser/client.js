import { fetchBrowserJson } from "./client-fetch.js";
function buildProfileQuery(profile) {
    return profile ? `?profile=${encodeURIComponent(profile)}` : "";
}
function withBaseUrl(baseUrl, path) {
    const trimmed = baseUrl?.trim();
    if (!trimmed) {
        return path;
    }
    return `${trimmed.replace(/\/$/, "")}${path}`;
}
export async function browserStatus(baseUrl, opts) {
    const q = buildProfileQuery(opts?.profile);
    return await fetchBrowserJson(withBaseUrl(baseUrl, `/${q}`), {
        timeoutMs: 1500,
    });
}
export async function browserProfiles(baseUrl) {
    const res = await fetchBrowserJson(withBaseUrl(baseUrl, `/profiles`), {
        timeoutMs: 3000,
    });
    return res.profiles ?? [];
}
export async function browserStart(baseUrl, opts) {
    const q = buildProfileQuery(opts?.profile);
    await fetchBrowserJson(withBaseUrl(baseUrl, `/start${q}`), {
        method: "POST",
        timeoutMs: 15000,
    });
}
export async function browserStop(baseUrl, opts) {
    const q = buildProfileQuery(opts?.profile);
    await fetchBrowserJson(withBaseUrl(baseUrl, `/stop${q}`), {
        method: "POST",
        timeoutMs: 15000,
    });
}
export async function browserResetProfile(baseUrl, opts) {
    const q = buildProfileQuery(opts?.profile);
    return await fetchBrowserJson(withBaseUrl(baseUrl, `/reset-profile${q}`), {
        method: "POST",
        timeoutMs: 20000,
    });
}
export async function browserCreateProfile(baseUrl, opts) {
    return await fetchBrowserJson(withBaseUrl(baseUrl, `/profiles/create`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name: opts.name,
            color: opts.color,
            cdpUrl: opts.cdpUrl,
            driver: opts.driver,
        }),
        timeoutMs: 10000,
    });
}
export async function browserDeleteProfile(baseUrl, profile) {
    return await fetchBrowserJson(withBaseUrl(baseUrl, `/profiles/${encodeURIComponent(profile)}`), {
        method: "DELETE",
        timeoutMs: 20000,
    });
}
export async function browserTabs(baseUrl, opts) {
    const q = buildProfileQuery(opts?.profile);
    const res = await fetchBrowserJson(withBaseUrl(baseUrl, `/tabs${q}`), { timeoutMs: 3000 });
    return res.tabs ?? [];
}
export async function browserOpenTab(baseUrl, url, opts) {
    const q = buildProfileQuery(opts?.profile);
    return await fetchBrowserJson(withBaseUrl(baseUrl, `/tabs/open${q}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
        timeoutMs: 15000,
    });
}
export async function browserFocusTab(baseUrl, targetId, opts) {
    const q = buildProfileQuery(opts?.profile);
    await fetchBrowserJson(withBaseUrl(baseUrl, `/tabs/focus${q}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId }),
        timeoutMs: 5000,
    });
}
export async function browserCloseTab(baseUrl, targetId, opts) {
    const q = buildProfileQuery(opts?.profile);
    await fetchBrowserJson(withBaseUrl(baseUrl, `/tabs/${encodeURIComponent(targetId)}${q}`), {
        method: "DELETE",
        timeoutMs: 5000,
    });
}
export async function browserTabAction(baseUrl, opts) {
    const q = buildProfileQuery(opts.profile);
    return await fetchBrowserJson(withBaseUrl(baseUrl, `/tabs/action${q}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            action: opts.action,
            index: opts.index,
        }),
        timeoutMs: 10000,
    });
}
export async function browserSnapshot(baseUrl, opts) {
    const q = new URLSearchParams();
    q.set("format", opts.format);
    if (opts.targetId) {
        q.set("targetId", opts.targetId);
    }
    if (typeof opts.limit === "number") {
        q.set("limit", String(opts.limit));
    }
    if (typeof opts.maxChars === "number" && Number.isFinite(opts.maxChars)) {
        q.set("maxChars", String(opts.maxChars));
    }
    if (opts.refs === "aria" || opts.refs === "role") {
        q.set("refs", opts.refs);
    }
    if (typeof opts.interactive === "boolean") {
        q.set("interactive", String(opts.interactive));
    }
    if (typeof opts.compact === "boolean") {
        q.set("compact", String(opts.compact));
    }
    if (typeof opts.depth === "number" && Number.isFinite(opts.depth)) {
        q.set("depth", String(opts.depth));
    }
    if (opts.selector?.trim()) {
        q.set("selector", opts.selector.trim());
    }
    if (opts.frame?.trim()) {
        q.set("frame", opts.frame.trim());
    }
    if (opts.labels === true) {
        q.set("labels", "1");
    }
    if (opts.mode) {
        q.set("mode", opts.mode);
    }
    if (opts.profile) {
        q.set("profile", opts.profile);
    }
    return await fetchBrowserJson(withBaseUrl(baseUrl, `/snapshot?${q.toString()}`), {
        timeoutMs: 20000,
    });
}
// Actions beyond the basic read-only commands live in client-actions.ts.
