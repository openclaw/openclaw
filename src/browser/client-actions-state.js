import { buildProfileQuery, withBaseUrl } from "./client-actions-url.js";
import { fetchBrowserJson } from "./client-fetch.js";
export async function browserCookies(baseUrl, opts = {}) {
    const q = new URLSearchParams();
    if (opts.targetId) {
        q.set("targetId", opts.targetId);
    }
    if (opts.profile) {
        q.set("profile", opts.profile);
    }
    const suffix = q.toString() ? `?${q.toString()}` : "";
    return await fetchBrowserJson(withBaseUrl(baseUrl, `/cookies${suffix}`), { timeoutMs: 20000 });
}
export async function browserCookiesSet(baseUrl, opts) {
    const q = buildProfileQuery(opts.profile);
    return await fetchBrowserJson(withBaseUrl(baseUrl, `/cookies/set${q}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId: opts.targetId, cookie: opts.cookie }),
        timeoutMs: 20000,
    });
}
export async function browserCookiesClear(baseUrl, opts = {}) {
    const q = buildProfileQuery(opts.profile);
    return await fetchBrowserJson(withBaseUrl(baseUrl, `/cookies/clear${q}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId: opts.targetId }),
        timeoutMs: 20000,
    });
}
export async function browserStorageGet(baseUrl, opts) {
    const q = new URLSearchParams();
    if (opts.targetId) {
        q.set("targetId", opts.targetId);
    }
    if (opts.key) {
        q.set("key", opts.key);
    }
    if (opts.profile) {
        q.set("profile", opts.profile);
    }
    const suffix = q.toString() ? `?${q.toString()}` : "";
    return await fetchBrowserJson(withBaseUrl(baseUrl, `/storage/${opts.kind}${suffix}`), { timeoutMs: 20000 });
}
export async function browserStorageSet(baseUrl, opts) {
    const q = buildProfileQuery(opts.profile);
    return await fetchBrowserJson(withBaseUrl(baseUrl, `/storage/${opts.kind}/set${q}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            targetId: opts.targetId,
            key: opts.key,
            value: opts.value,
        }),
        timeoutMs: 20000,
    });
}
export async function browserStorageClear(baseUrl, opts) {
    const q = buildProfileQuery(opts.profile);
    return await fetchBrowserJson(withBaseUrl(baseUrl, `/storage/${opts.kind}/clear${q}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId: opts.targetId }),
        timeoutMs: 20000,
    });
}
export async function browserSetOffline(baseUrl, opts) {
    const q = buildProfileQuery(opts.profile);
    return await fetchBrowserJson(withBaseUrl(baseUrl, `/set/offline${q}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId: opts.targetId, offline: opts.offline }),
        timeoutMs: 20000,
    });
}
export async function browserSetHeaders(baseUrl, opts) {
    const q = buildProfileQuery(opts.profile);
    return await fetchBrowserJson(withBaseUrl(baseUrl, `/set/headers${q}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId: opts.targetId, headers: opts.headers }),
        timeoutMs: 20000,
    });
}
export async function browserSetHttpCredentials(baseUrl, opts = {}) {
    const q = buildProfileQuery(opts.profile);
    return await fetchBrowserJson(withBaseUrl(baseUrl, `/set/credentials${q}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            targetId: opts.targetId,
            username: opts.username,
            password: opts.password,
            clear: opts.clear,
        }),
        timeoutMs: 20000,
    });
}
export async function browserSetGeolocation(baseUrl, opts = {}) {
    const q = buildProfileQuery(opts.profile);
    return await fetchBrowserJson(withBaseUrl(baseUrl, `/set/geolocation${q}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            targetId: opts.targetId,
            latitude: opts.latitude,
            longitude: opts.longitude,
            accuracy: opts.accuracy,
            origin: opts.origin,
            clear: opts.clear,
        }),
        timeoutMs: 20000,
    });
}
export async function browserSetMedia(baseUrl, opts) {
    const q = buildProfileQuery(opts.profile);
    return await fetchBrowserJson(withBaseUrl(baseUrl, `/set/media${q}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            targetId: opts.targetId,
            colorScheme: opts.colorScheme,
        }),
        timeoutMs: 20000,
    });
}
export async function browserSetTimezone(baseUrl, opts) {
    const q = buildProfileQuery(opts.profile);
    return await fetchBrowserJson(withBaseUrl(baseUrl, `/set/timezone${q}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            targetId: opts.targetId,
            timezoneId: opts.timezoneId,
        }),
        timeoutMs: 20000,
    });
}
export async function browserSetLocale(baseUrl, opts) {
    const q = buildProfileQuery(opts.profile);
    return await fetchBrowserJson(withBaseUrl(baseUrl, `/set/locale${q}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId: opts.targetId, locale: opts.locale }),
        timeoutMs: 20000,
    });
}
export async function browserSetDevice(baseUrl, opts) {
    const q = buildProfileQuery(opts.profile);
    return await fetchBrowserJson(withBaseUrl(baseUrl, `/set/device${q}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId: opts.targetId, name: opts.name }),
        timeoutMs: 20000,
    });
}
export async function browserClearPermissions(baseUrl, opts = {}) {
    const q = buildProfileQuery(opts.profile);
    return await fetchBrowserJson(withBaseUrl(baseUrl, `/set/geolocation${q}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId: opts.targetId, clear: true }),
        timeoutMs: 20000,
    });
}
