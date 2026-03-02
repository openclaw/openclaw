import path from "node:path";
import { fetchWithSsrFGuard, withStrictGuardedFetchMode } from "../infra/net/fetch-guard.js";
import type { LookupFn, SsrFPolicy } from "../infra/net/ssrf.js";
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
};

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

function isQuotedHeaderValue(value: string): boolean {
  if (value.length < 2) {
    return false;
  }
  const first = value[0];
  const last = value[value.length - 1];
  return (first === '"' || first === "'") && last === first;
}

function unescapeHttpQuotedPair(value: string): string {
  let result = "";
  let escaping = false;
  for (const char of value) {
    if (escaping) {
      result += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    result += char;
  }
  if (escaping) {
    // Preserve a malformed trailing escape so callers do not lose data.
    result += "\\";
  }
  return result;
}

function basenameWithWindowsSeparatorHeuristic(value: string): string {
  let segment = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === "/") {
      segment = "";
      continue;
    }
    if (char === "\\") {
      const next = value[i + 1];
      // Preserve a literal backslash immediately before a quote so valid
      // quoted-string filenames like foo\\"bar.txt are not truncated.
      if (next !== '"' && next !== "'") {
        segment = "";
        continue;
      }
    }
    segment += char;
  }
  return segment;
}

function sanitizeContentDispositionFileName(value: string): string {
  // Strip control chars to avoid downstream header/log injection surprises.
  const withoutControls = Array.from(value)
    .filter((char) => {
      const codePoint = char.codePointAt(0) ?? 0x7f;
      return codePoint >= 0x20 && codePoint !== 0x7f;
    })
    .join("");
  return basenameWithWindowsSeparatorHeuristic(withoutControls);
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
      return sanitizeContentDispositionFileName(decodeURIComponent(encoded));
    } catch {
      return sanitizeContentDispositionFileName(encoded);
    }
  }
  const match = /filename\s*=\s*([^;]+)/i.exec(header);
  if (match?.[1]) {
    const rawValue = match[1].trim();
    const unquoted = stripQuotes(rawValue);
    const decodedValue = isQuotedHeaderValue(rawValue)
      ? unescapeHttpQuotedPair(unquoted)
      : unquoted;
    return sanitizeContentDispositionFileName(decodedValue);
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
  } = options;

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
