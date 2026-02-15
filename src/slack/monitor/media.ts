import type { WebClient as SlackWebClient } from "@slack/web-api";
import type { FetchLike } from "../../media/fetch.js";
import type { SlackFile } from "../types.js";
import { fetchRemoteMedia } from "../../media/fetch.js";
import { saveMediaBuffer } from "../../media/store.js";

function normalizeHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized.slice(1, -1);
  }
  return normalized;
}

function isSlackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (!normalized) {
    return false;
  }
  // Slack-hosted files typically come from *.slack.com and redirect to Slack CDN domains.
  // Include a small allowlist of known Slack domains to avoid leaking tokens if a file URL
  // is ever spoofed or mishandled.
  const allowedSuffixes = ["slack.com", "slack-edge.com", "slack-files.com"];
  return allowedSuffixes.some(
    (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
  );
}

function assertSlackFileUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid Slack file URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Refusing Slack file URL with non-HTTPS protocol: ${parsed.protocol}`);
  }
  if (!isSlackHostname(parsed.hostname)) {
    throw new Error(
      `Refusing to send Slack token to non-Slack host "${parsed.hostname}" (url: ${rawUrl})`,
    );
  }
  return parsed;
}

function resolveRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if ("url" in input && typeof input.url === "string") {
    return input.url;
  }
  throw new Error("Unsupported fetch input: expected string, URL, or Request");
}

function createSlackMediaFetch(token: string): FetchLike {
  let includeAuth = true;
  return async (input, init) => {
    const url = resolveRequestUrl(input);
    const { headers: initHeaders, redirect: _redirect, ...rest } = init ?? {};
    const headers = new Headers(initHeaders);

    if (includeAuth) {
      includeAuth = false;
      const parsed = assertSlackFileUrl(url);
      headers.set("Authorization", `Bearer ${token}`);
      return fetch(parsed.href, { ...rest, headers, redirect: "manual" });
    }

    headers.delete("Authorization");
    return fetch(url, { ...rest, headers, redirect: "manual" });
  };
}

/**
 * Fetches a URL with Authorization header, handling cross-origin redirects.
 * Node.js fetch strips Authorization headers on cross-origin redirects for security.
 * Slack's file URLs redirect to CDN domains with pre-signed URLs that don't need the
 * Authorization header, so we handle the initial auth request manually.
 */
export async function fetchWithSlackAuth(url: string, token: string): Promise<Response> {
  const parsed = assertSlackFileUrl(url);

  // Initial request with auth and manual redirect handling
  const initialRes = await fetch(parsed.href, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "manual",
  });

  // If not a redirect, return the response directly
  if (initialRes.status < 300 || initialRes.status >= 400) {
    return initialRes;
  }

  // Handle redirect - the redirected URL should be pre-signed and not need auth
  const redirectUrl = initialRes.headers.get("location");
  if (!redirectUrl) {
    return initialRes;
  }

  // Resolve relative URLs against the original
  const resolvedUrl = new URL(redirectUrl, parsed.href);

  // Only follow safe protocols (we do NOT include Authorization on redirects).
  if (resolvedUrl.protocol !== "https:") {
    return initialRes;
  }

  // Follow the redirect without the Authorization header
  // (Slack's CDN URLs are pre-signed and don't need it)
  return fetch(resolvedUrl.toString(), { redirect: "follow" });
}

/**
 * Slack voice messages (audio clips, huddle recordings) carry a `subtype` of
 * `"slack_audio"` but are served with a `video/*` MIME type (e.g. `video/mp4`,
 * `video/webm`).  Override the primary type to `audio/` so the
 * media-understanding pipeline routes them to transcription.
 */
function resolveSlackMediaMimetype(
  file: SlackFile,
  fetchedContentType?: string,
): string | undefined {
  const mime = fetchedContentType ?? file.mimetype;
  if (file.subtype === "slack_audio" && mime?.startsWith("video/")) {
    return mime.replace("video/", "audio/");
  }
  return mime;
}

export type SlackMediaResult = {
  path: string;
  contentType?: string;
  placeholder: string;
};

const MAX_SLACK_MEDIA_FILES = 8;
const MAX_SLACK_MEDIA_CONCURRENCY = 3;

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const results: R[] = [];
  results.length = items.length;
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const idx = nextIndex++;
        if (idx >= items.length) {
          return;
        }
        results[idx] = await fn(items[idx]);
      }
    }),
  );
  return results;
}

/**
 * Downloads all files attached to a Slack message and returns them as an array.
 * Returns `null` when no files could be downloaded.
 */
export async function resolveSlackMedia(params: {
  files?: SlackFile[];
  token: string;
  maxBytes: number;
}): Promise<SlackMediaResult[] | null> {
  const files = params.files ?? [];
  const limitedFiles =
    files.length > MAX_SLACK_MEDIA_FILES ? files.slice(0, MAX_SLACK_MEDIA_FILES) : files;

  const resolved = await mapLimit<SlackFile, SlackMediaResult | null>(
    limitedFiles,
    MAX_SLACK_MEDIA_CONCURRENCY,
    async (file) => {
      const url = file.url_private_download ?? file.url_private;
      if (!url) {
        return null;
      }
      try {
        // Note: fetchRemoteMedia calls fetchImpl(url) with the URL string today and
        // handles size limits internally. Provide a fetcher that uses auth once, then lets
        // the redirect chain continue without credentials.
        const fetchImpl = createSlackMediaFetch(params.token);
        const fetched = await fetchRemoteMedia({
          url,
          fetchImpl,
          filePathHint: file.name,
          maxBytes: params.maxBytes,
        });
        if (fetched.buffer.byteLength > params.maxBytes) {
          return null;
        }
        const effectiveMime = resolveSlackMediaMimetype(file, fetched.contentType);
        const saved = await saveMediaBuffer(
          fetched.buffer,
          effectiveMime,
          "inbound",
          params.maxBytes,
        );
        const label = fetched.fileName ?? file.name;
        const contentType = effectiveMime ?? saved.contentType;
        return {
          path: saved.path,
          ...(contentType ? { contentType } : {}),
          placeholder: label ? `[Slack file: ${label}]` : "[Slack file]",
        };
      } catch {
        return null;
      }
    },
  );

  const results = resolved.filter((entry): entry is SlackMediaResult => Boolean(entry));
  return results.length > 0 ? results : null;
}

export type SlackThreadStarter = {
  text: string;
  userId?: string;
  ts?: string;
  files?: SlackFile[];
};

const THREAD_STARTER_CACHE = new Map<string, SlackThreadStarter>();

export async function resolveSlackThreadStarter(params: {
  channelId: string;
  threadTs: string;
  client: SlackWebClient;
}): Promise<SlackThreadStarter | null> {
  const cacheKey = `${params.channelId}:${params.threadTs}`;
  const cached = THREAD_STARTER_CACHE.get(cacheKey);
  if (cached) {
    return cached;
  }
  try {
    const response = (await params.client.conversations.replies({
      channel: params.channelId,
      ts: params.threadTs,
      limit: 1,
      inclusive: true,
    })) as { messages?: Array<{ text?: string; user?: string; ts?: string; files?: SlackFile[] }> };
    const message = response?.messages?.[0];
    const text = (message?.text ?? "").trim();
    if (!message || !text) {
      return null;
    }
    const starter: SlackThreadStarter = {
      text,
      userId: message.user,
      ts: message.ts,
      files: message.files,
    };
    THREAD_STARTER_CACHE.set(cacheKey, starter);
    return starter;
  } catch {
    return null;
  }
}

export type SlackThreadMessage = {
  text: string;
  userId?: string;
  ts?: string;
  botId?: string;
  files?: SlackFile[];
};

type SlackRepliesPageMessage = {
  text?: string;
  user?: string;
  bot_id?: string;
  ts?: string;
  files?: SlackFile[];
};

type SlackRepliesPage = {
  messages?: SlackRepliesPageMessage[];
  response_metadata?: { next_cursor?: string };
};

/**
 * Fetches the most recent messages in a Slack thread (excluding the current message).
 * Used to populate thread context when a new thread session starts.
 *
 * Uses cursor pagination and keeps only the latest N retained messages so long threads
 * still produce up-to-date context without unbounded memory growth.
 */
export async function resolveSlackThreadHistory(params: {
  channelId: string;
  threadTs: string;
  client: SlackWebClient;
  currentMessageTs?: string;
  limit?: number;
}): Promise<SlackThreadMessage[]> {
  const maxMessages = params.limit ?? 20;
  if (!Number.isFinite(maxMessages) || maxMessages <= 0) {
    return [];
  }

  // Slack recommends no more than 200 per page.
  const fetchLimit = 200;
  const retained: SlackRepliesPageMessage[] = [];
  let cursor: string | undefined;

  try {
    do {
      const response = (await params.client.conversations.replies({
        channel: params.channelId,
        ts: params.threadTs,
        limit: fetchLimit,
        inclusive: true,
        ...(cursor ? { cursor } : {}),
      })) as SlackRepliesPage;

      for (const msg of response.messages ?? []) {
        // Keep messages with text OR file attachments
        if (!msg.text?.trim() && !msg.files?.length) {
          continue;
        }
        if (params.currentMessageTs && msg.ts === params.currentMessageTs) {
          continue;
        }
        retained.push(msg);
        if (retained.length > maxMessages) {
          retained.shift();
        }
      }

      const next = response.response_metadata?.next_cursor;
      cursor = typeof next === "string" && next.trim().length > 0 ? next.trim() : undefined;
    } while (cursor);

    return retained.map((msg) => ({
      // For file-only messages, create a placeholder showing attached filenames
      text: msg.text?.trim()
        ? msg.text
        : `[attached: ${msg.files?.map((f) => f.name ?? "file").join(", ")}]`,
      userId: msg.user,
      botId: msg.bot_id,
      ts: msg.ts,
      files: msg.files,
    }));
  } catch {
    return [];
  }
}
