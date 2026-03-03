import { buildProfileQuery, withBaseUrl } from "./client-actions-url.js";
import { fetchBrowserJson } from "./client-fetch.js";
async function postDownloadRequest(baseUrl, route, body, profile) {
    const q = buildProfileQuery(profile);
    return await fetchBrowserJson(withBaseUrl(baseUrl, `${route}${q}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs: 20000,
    });
}
export async function browserNavigate(baseUrl, opts) {
    const q = buildProfileQuery(opts.profile);
    return await fetchBrowserJson(withBaseUrl(baseUrl, `/navigate${q}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: opts.url, targetId: opts.targetId }),
        timeoutMs: 20000,
    });
}
export async function browserArmDialog(baseUrl, opts) {
    const q = buildProfileQuery(opts.profile);
    return await fetchBrowserJson(withBaseUrl(baseUrl, `/hooks/dialog${q}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            accept: opts.accept,
            promptText: opts.promptText,
            targetId: opts.targetId,
            timeoutMs: opts.timeoutMs,
        }),
        timeoutMs: 20000,
    });
}
export async function browserArmFileChooser(baseUrl, opts) {
    const q = buildProfileQuery(opts.profile);
    return await fetchBrowserJson(withBaseUrl(baseUrl, `/hooks/file-chooser${q}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            paths: opts.paths,
            ref: opts.ref,
            inputRef: opts.inputRef,
            element: opts.element,
            targetId: opts.targetId,
            timeoutMs: opts.timeoutMs,
        }),
        timeoutMs: 20000,
    });
}
export async function browserWaitForDownload(baseUrl, opts) {
    return await postDownloadRequest(baseUrl, "/wait/download", {
        targetId: opts.targetId,
        path: opts.path,
        timeoutMs: opts.timeoutMs,
    }, opts.profile);
}
export async function browserDownload(baseUrl, opts) {
    return await postDownloadRequest(baseUrl, "/download", {
        targetId: opts.targetId,
        ref: opts.ref,
        path: opts.path,
        timeoutMs: opts.timeoutMs,
    }, opts.profile);
}
export async function browserAct(baseUrl, req, opts) {
    const q = buildProfileQuery(opts?.profile);
    return await fetchBrowserJson(withBaseUrl(baseUrl, `/act${q}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
        timeoutMs: 20000,
    });
}
export async function browserScreenshotAction(baseUrl, opts) {
    const q = buildProfileQuery(opts.profile);
    return await fetchBrowserJson(withBaseUrl(baseUrl, `/screenshot${q}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            targetId: opts.targetId,
            fullPage: opts.fullPage,
            ref: opts.ref,
            element: opts.element,
            type: opts.type,
        }),
        timeoutMs: 20000,
    });
}
