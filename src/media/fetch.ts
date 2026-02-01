import path from "node:path";
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
  const { url, fetchImpl, filePathHint, maxBytes } = options;
  const fetcher: FetchLike | undefined = fetchImpl ?? globalThis.fetch;
  if (!fetcher) {
    throw new Error("fetch is not available");
  }

  let res: Response;
  try {
    res = await fetcher(url);
  } catch (err) {
    throw new MediaFetchError("fetch_failed", `Failed to fetch media from ${url}: ${String(err)}`);
  }

  if (!res.ok) {
    const statusText = res.statusText ? ` ${res.statusText}` : "";
    const redirected = res.url && res.url !== url ? ` (redirected to ${res.url})` : "";
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
    const parsed = new URL(url);
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
