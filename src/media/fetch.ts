import type { lookup as dnsLookup } from "node:dns/promises";
import type { Dispatcher } from "undici";
import path from "node:path";
import {
  closeDispatcher,
  createPinnedDispatcher,
  resolvePinnedHostname,
  SsrFBlockedError,
} from "../infra/net/ssrf.js";
import { detectMime, extensionForMime } from "./mime.js";

type FetchMediaResult = {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
};

export type MediaFetchErrorCode = "max_bytes" | "http_error" | "fetch_failed";

export class MediaFetchError extends Error {
  readonly code: MediaFetchErrorCode;

  constructor(code: MediaFetchErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "MediaFetchError";
  }
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type FetchMediaOptions = {
  url: string;
  fetchImpl?: FetchLike;
  filePathHint?: string;
  maxBytes?: number;
  lookupFn?: LookupFn;
  maxRedirects?: number;
};

type LookupFn = typeof dnsLookup;

const DEFAULT_MAX_REDIRECTS = 3;

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

function parseContentDispositionFileName(header?: string | null): string | undefined {
  if (!header) {
    return undefined;
  }
  const starMatch = /filename\*\s*=\s*([^;]+)/i.exec(header);
  if (starMatch?.[1]) {
    const cleaned = stripQuotes(starMatch[1].trim());
    const encoded = cleaned.split("''").slice(1).join("''") || cleaned;
    try {
      return path.basename(decodeURIComponent(encoded));
    } catch {
      return path.basename(encoded);
    }
  }
  const match = /filename\s*=\s*([^;]+)/i.exec(header);
  if (match?.[1]) {
    return path.basename(stripQuotes(match[1].trim()));
  }
  return undefined;
}

async function readErrorBodySnippet(res: Response, maxChars = 200): Promise<string | undefined> {
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
  } catch {
    return undefined;
  }
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function fetchWithRedirects(params: {
  url: string;
  fetcher: FetchLike;
  lookupFn?: LookupFn;
  maxRedirects: number;
}): Promise<{ response: Response; finalUrl: string; dispatcher: Dispatcher }> {
  const visited = new Set<string>();
  let currentUrl = params.url;
  let redirectCount = 0;

  while (true) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(currentUrl);
    } catch {
      throw new Error("Invalid URL: must be http or https");
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new Error("Invalid URL: must be http or https");
    }

    const pinned = await resolvePinnedHostname(parsedUrl.hostname, params.lookupFn);
    const dispatcher = createPinnedDispatcher(pinned);
    let res: Response;
    try {
      res = await params.fetcher(parsedUrl.toString(), {
        redirect: "manual",
        dispatcher,
      } as RequestInit);
    } catch (err) {
      await closeDispatcher(dispatcher);
      throw err;
    }

    if (isRedirectStatus(res.status)) {
      const location = res.headers.get("location");
      await closeDispatcher(dispatcher);
      if (!location) {
        throw new Error(`Redirect missing location header (${res.status})`);
      }
      redirectCount += 1;
      if (redirectCount > params.maxRedirects) {
        throw new Error(`Too many redirects (limit: ${params.maxRedirects})`);
      }
      const nextUrl = new URL(location, parsedUrl).toString();
      if (visited.has(nextUrl)) {
        throw new Error("Redirect loop detected");
      }
      visited.add(nextUrl);
      void res.body?.cancel();
      currentUrl = nextUrl;
      continue;
    }

    return { response: res, finalUrl: currentUrl, dispatcher };
  }
}

export async function fetchRemoteMedia(options: FetchMediaOptions): Promise<FetchMediaResult> {
  const { url, fetchImpl, filePathHint, maxBytes, lookupFn, maxRedirects } = options;
  const fetcher: FetchLike | undefined = fetchImpl ?? globalThis.fetch;
  if (!fetcher) {
    throw new Error("fetch is not available");
  }

  let res: Response;
  let finalUrl = url;
  let dispatcher: Dispatcher | null = null;
  try {
    const fetched = await fetchWithRedirects({
      url,
      fetcher,
      lookupFn,
      maxRedirects: maxRedirects ?? DEFAULT_MAX_REDIRECTS,
    });
    res = fetched.response;
    finalUrl = fetched.finalUrl;
    dispatcher = fetched.dispatcher;
  } catch (err) {
    if (err instanceof SsrFBlockedError) {
      throw new MediaFetchError(
        "fetch_failed",
        `Failed to fetch media from ${url}: ${err.message}`,
      );
    }
    throw new MediaFetchError("fetch_failed", `Failed to fetch media from ${url}: ${String(err)}`);
  }

  try {
    if (!res.ok) {
      const statusText = res.statusText ? ` ${res.statusText}` : "";
      const redirected = finalUrl && finalUrl !== url ? ` (redirected to ${finalUrl})` : "";
      let detail = `HTTP ${res.status}${statusText}`;
      if (!res.body) {
        detail = `HTTP ${res.status}${statusText}; empty response body`;
      } else {
        const snippet = await readErrorBodySnippet(res);
        if (snippet) {
          detail += `; body: ${snippet}`;
        }
      }
      throw new MediaFetchError(
        "http_error",
        `Failed to fetch media from ${url}${redirected}: ${detail}`,
      );
    }

    const contentLength = res.headers.get("content-length");
    if (maxBytes && contentLength) {
      const length = Number(contentLength);
      if (Number.isFinite(length) && length > maxBytes) {
        throw new MediaFetchError(
          "max_bytes",
          `Failed to fetch media from ${url}: content length ${length} exceeds maxBytes ${maxBytes}`,
        );
      }
    }

    const buffer = maxBytes
      ? await readResponseWithLimit(res, maxBytes)
      : Buffer.from(await res.arrayBuffer());
    let fileNameFromUrl: string | undefined;
    try {
      const parsed = new URL(finalUrl || url);
      const base = path.basename(parsed.pathname);
      fileNameFromUrl = base || undefined;
    } catch {
      // ignore parse errors; leave undefined
    }

    const headerFileName = parseContentDispositionFileName(res.headers.get("content-disposition"));
    let fileName =
      headerFileName || fileNameFromUrl || (filePathHint ? path.basename(filePathHint) : undefined);

    const filePathForMime =
      headerFileName && path.extname(headerFileName) ? headerFileName : (filePathHint ?? url);
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
  } finally {
    await closeDispatcher(dispatcher);
  }
}

async function readResponseWithLimit(res: Response, maxBytes: number): Promise<Buffer> {
  const body = res.body;
  if (!body || typeof body.getReader !== "function") {
    const fallback = Buffer.from(await res.arrayBuffer());
    if (fallback.length > maxBytes) {
      throw new MediaFetchError(
        "max_bytes",
        `Failed to fetch media from ${res.url || "response"}: payload exceeds maxBytes ${maxBytes}`,
      );
    }
    return fallback;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value?.length) {
        total += value.length;
        if (total > maxBytes) {
          try {
            await reader.cancel();
          } catch {}
          throw new MediaFetchError(
            "max_bytes",
            `Failed to fetch media from ${res.url || "response"}: payload exceeds maxBytes ${maxBytes}`,
          );
        }
        chunks.push(value);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }

  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  );
}
