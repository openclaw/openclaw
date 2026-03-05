import path from "node:path";
import { fetchWithSsrFGuard, withStrictGuardedFetchMode } from "../infra/net/fetch-guard.js";
import type { LookupFn, SsrFPolicy } from "../infra/net/ssrf.js";
import { retryAsync } from "../infra/retry.js";
import { detectMime, extensionForMime } from "./mime.js";
import { readResponseWithLimit } from "./read-response-with-limit.js";

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

/**
 * Returns true if the error is a transient network error that should be retried.
 * Returns false for permanent errors like "file too big" (413) or client errors (4xx).
 */
function isTransientMediaFetchError(err: unknown): boolean {
  // Retry MediaFetchError with fetch_failed code (network issues)
  if (err instanceof MediaFetchError) {
    if (err.code === "fetch_failed") {
      return true;
    }
    // Don't retry http_error or max_bytes - they're permanent
    return false;
  }

  // Retry generic fetch errors that might be network-related
  if (err instanceof Error) {
    const message = err.message.toLowerCase();
    // Check for common transient network error patterns
    const transientPatterns = [
      "fetch failed",
      "econnreset",
      "econnrefused",
      "etimedout",
      "enotfound",
      "enetunreach",
      "ehostunreach",
      "socket hang up",
      "network error",
      "connection error",
      "connection reset",
      "connection refused",
      "connection timeout",
      "dns error",
    ];
    return transientPatterns.some((pattern) => message.includes(pattern));
  }

  // Default to not retry for unknown error types
  return false;
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type FetchMediaOptions = {
  url: string;
  fetchImpl?: FetchLike;
  requestInit?: RequestInit;
  filePathHint?: string;
  maxBytes?: number;
  maxRedirects?: number;
  ssrfPolicy?: SsrFPolicy;
  lookupFn?: LookupFn;
  /** Number of retry attempts for transient network errors (default: 2) */
  retryCount?: number;
};

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

export async function fetchRemoteMedia(options: FetchMediaOptions): Promise<FetchMediaResult> {
  const {
    url,
    fetchImpl,
    requestInit,
    filePathHint,
    maxBytes,
    maxRedirects,
    ssrfPolicy,
    lookupFn,
    retryCount = 2,
  } = options;

  // If retryCount > 0, wrap the fetch in retry logic for transient errors
  if (retryCount > 0) {
    return retryAsync(async () => fetchRemoteMedia({ ...options, retryCount: 0 }), {
      attempts: retryCount + 1, // +1 for the initial attempt
      minDelayMs: 500,
      maxDelayMs: 2000,
      jitter: 0.3,
      label: "media:fetch",
      shouldRetry: isTransientMediaFetchError,
    });
  }

  let res: Response;
  let finalUrl = url;
  let release: (() => Promise<void>) | null = null;
  try {
    const result = await fetchWithSsrFGuard(
      withStrictGuardedFetchMode({
        url,
        fetchImpl,
        init: requestInit,
        maxRedirects,
        policy: ssrfPolicy,
        lookupFn,
      }),
    );
    res = result.response;
    finalUrl = result.finalUrl;
    release = result.release;
  } catch (err) {
    throw new MediaFetchError("fetch_failed", `Failed to fetch media from ${url}: ${String(err)}`);
  }

  try {
    if (!res.ok) {
      const statusText = res.statusText ? ` ${res.statusText}` : "";
      const redirected = finalUrl !== url ? ` (redirected to ${finalUrl})` : "";
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
      ? await readResponseWithLimit(res, maxBytes, {
          onOverflow: ({ maxBytes, res }) =>
            new MediaFetchError(
              "max_bytes",
              `Failed to fetch media from ${res.url || url}: payload exceeds maxBytes ${maxBytes}`,
            ),
        })
      : Buffer.from(await res.arrayBuffer());
    let fileNameFromUrl: string | undefined;
    try {
      const parsed = new URL(finalUrl);
      const base = path.basename(parsed.pathname);
      fileNameFromUrl = base || undefined;
    } catch {
      // ignore parse errors; leave undefined
    }

    const headerFileName = parseContentDispositionFileName(res.headers.get("content-disposition"));
    let fileName =
      headerFileName || fileNameFromUrl || (filePathHint ? path.basename(filePathHint) : undefined);

    const filePathForMime =
      headerFileName && path.extname(headerFileName) ? headerFileName : (filePathHint ?? finalUrl);
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
    if (release) {
      await release();
    }
  }
}
