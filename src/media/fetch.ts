import path from "node:path";

import { detectMime, extensionForMime } from "./mime.js";

type FetchMediaResult = {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
};

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type FetchMediaOptions = {
  url: string;
  fetchImpl?: FetchLike;
  filePathHint?: string;
};

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

function parseContentDispositionFileName(
  header?: string | null,
): string | undefined {
  if (!header) return undefined;
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
  if (match?.[1]) return path.basename(stripQuotes(match[1].trim()));
  return undefined;
}

async function readErrorBodySnippet(
  res: Response,
  maxChars = 200,
): Promise<string | undefined> {
  try {
    const text = await res.text();
    if (!text) return undefined;
    const collapsed = text.replace(/\s+/g, " ").trim();
    if (!collapsed) return undefined;
    if (collapsed.length <= maxChars) return collapsed;
    return `${collapsed.slice(0, maxChars)}…`;
  } catch {
    return undefined;
  }
}

export async function fetchRemoteMedia(
  options: FetchMediaOptions,
): Promise<FetchMediaResult> {
  const { url, fetchImpl, filePathHint } = options;
  const fetcher: FetchLike | undefined = fetchImpl ?? globalThis.fetch;
  if (!fetcher) {
    throw new Error("fetch is not available");
  }

  let res: Response;
  try {
    res = await fetcher(url);
  } catch (err) {
    throw new Error(`Failed to fetch media from ${url}: ${String(err)}`);
  }

  if (!res.ok) {
    const statusText = res.statusText ? ` ${res.statusText}` : "";
    const redirected =
      res.url && res.url !== url ? ` (redirected to ${res.url})` : "";
    let detail = `HTTP ${res.status}${statusText}`;
    if (!res.body) {
      detail = `HTTP ${res.status}${statusText}; empty response body`;
    } else {
      const snippet = await readErrorBodySnippet(res);
      if (snippet) detail += `; body: ${snippet}`;
    }
    throw new Error(
      `Failed to fetch media from ${url}${redirected}: ${detail}`,
    );
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  let fileNameFromUrl: string | undefined;
  try {
    const parsed = new URL(url);
    const base = path.basename(parsed.pathname);
    fileNameFromUrl = base || undefined;
  } catch {
    // ignore parse errors; leave undefined
  }

  const headerFileName = parseContentDispositionFileName(
    res.headers.get("content-disposition"),
  );
  let fileName =
    headerFileName ||
    fileNameFromUrl ||
    (filePathHint ? path.basename(filePathHint) : undefined);

  const filePathForMime =
    headerFileName && path.extname(headerFileName)
      ? headerFileName
      : (filePathHint ?? url);
  const contentType = await detectMime({
    buffer,
    headerMime: res.headers.get("content-type"),
    filePath: filePathForMime,
  });
  if (fileName && !path.extname(fileName) && contentType) {
    const ext = extensionForMime(contentType);
    if (ext) fileName = `${fileName}${ext}`;
  }

  return {
    buffer,
    contentType: contentType ?? undefined,
    fileName,
  };
}
