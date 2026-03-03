import path from "node:path";
import { fetchWithSsrFGuard, withStrictGuardedFetchMode } from "../infra/net/fetch-guard.js";
import { detectMime, extensionForMime } from "./mime.js";
import { readResponseWithLimit } from "./read-response-with-limit.js";
export class MediaFetchError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "MediaFetchError";
    }
}
function stripQuotes(value) {
    return value.replace(/^["']|["']$/g, "");
}
function parseContentDispositionFileName(header) {
    if (!header) {
        return undefined;
    }
    const starMatch = /filename\*\s*=\s*([^;]+)/i.exec(header);
    if (starMatch?.[1]) {
        const cleaned = stripQuotes(starMatch[1].trim());
        const encoded = cleaned.split("''").slice(1).join("''") || cleaned;
        try {
            return path.basename(decodeURIComponent(encoded));
        }
        catch {
            return path.basename(encoded);
        }
    }
    const match = /filename\s*=\s*([^;]+)/i.exec(header);
    if (match?.[1]) {
        return path.basename(stripQuotes(match[1].trim()));
    }
    return undefined;
}
async function readErrorBodySnippet(res, maxChars = 200) {
    try {
        const text = await res.text();
        if (!text) {
            return undefined;
        }
        const collapsed = text.replace(/\s+/g, " ").trim();
        if (!collapsed) {
            return undefined;
        }
        if (collapsed.length <= maxChars) {
            return collapsed;
        }
        return `${collapsed.slice(0, maxChars)}…`;
    }
    catch {
        return undefined;
    }
}
export async function fetchRemoteMedia(options) {
    const { url, fetchImpl, requestInit, filePathHint, maxBytes, maxRedirects, ssrfPolicy, lookupFn, } = options;
    let res;
    let finalUrl = url;
    let release = null;
    try {
        const result = await fetchWithSsrFGuard(withStrictGuardedFetchMode({
            url,
            fetchImpl,
            init: requestInit,
            maxRedirects,
            policy: ssrfPolicy,
            lookupFn,
        }));
        res = result.response;
        finalUrl = result.finalUrl;
        release = result.release;
    }
    catch (err) {
        throw new MediaFetchError("fetch_failed", `Failed to fetch media from ${url}: ${String(err)}`);
    }
    try {
        if (!res.ok) {
            const statusText = res.statusText ? ` ${res.statusText}` : "";
            const redirected = finalUrl !== url ? ` (redirected to ${finalUrl})` : "";
            let detail = `HTTP ${res.status}${statusText}`;
            if (!res.body) {
                detail = `HTTP ${res.status}${statusText}; empty response body`;
            }
            else {
                const snippet = await readErrorBodySnippet(res);
                if (snippet) {
                    detail += `; body: ${snippet}`;
                }
            }
            throw new MediaFetchError("http_error", `Failed to fetch media from ${url}${redirected}: ${detail}`);
        }
        const contentLength = res.headers.get("content-length");
        if (maxBytes && contentLength) {
            const length = Number(contentLength);
            if (Number.isFinite(length) && length > maxBytes) {
                throw new MediaFetchError("max_bytes", `Failed to fetch media from ${url}: content length ${length} exceeds maxBytes ${maxBytes}`);
            }
        }
        const buffer = maxBytes
            ? await readResponseWithLimit(res, maxBytes, {
                onOverflow: ({ maxBytes, res }) => new MediaFetchError("max_bytes", `Failed to fetch media from ${res.url || url}: payload exceeds maxBytes ${maxBytes}`),
            })
            : Buffer.from(await res.arrayBuffer());
        let fileNameFromUrl;
        try {
            const parsed = new URL(finalUrl);
            const base = path.basename(parsed.pathname);
            fileNameFromUrl = base || undefined;
        }
        catch {
            // ignore parse errors; leave undefined
        }
        const headerFileName = parseContentDispositionFileName(res.headers.get("content-disposition"));
        let fileName = headerFileName || fileNameFromUrl || (filePathHint ? path.basename(filePathHint) : undefined);
        const filePathForMime = headerFileName && path.extname(headerFileName) ? headerFileName : (filePathHint ?? finalUrl);
        const contentType = await detectMime({
            buffer,
            headerMime: res.headers.get("content-type"),
            filePath: filePathForMime,
        });
        if (fileName && !path.extname(fileName) && contentType) {
            const ext = extensionForMime(contentType);
            if (ext) {
                fileName = `${fileName}${ext}`;
            }
        }
        return {
            buffer,
            contentType: contentType ?? undefined,
            fileName,
        };
    }
    finally {
        if (release) {
            await release();
        }
    }
}
