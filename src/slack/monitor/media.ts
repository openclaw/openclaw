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

export async function resolveSlackMedia(params: {
  files?: SlackFile[];
  token: string;
  maxBytes: number;
}): Promise<{
  path: string;
  contentType?: string;
  placeholder: string;
} | null> {
  const files = params.files ?? [];
  for (const file of files) {
    const url = file.url_private_download ?? file.url_private;
    if (!url) {
      continue;
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
        continue;
      }
      const saved = await saveMediaBuffer(
        fetched.buffer,
        fetched.contentType ?? file.mimetype,
        "inbound",
        params.maxBytes,
      );
      const label = fetched.fileName ?? file.name;
      return {
        path: saved.path,
        contentType: saved.contentType,
        placeholder: label ? `[Slack file: ${label}]` : "[Slack file]",
      };
    } catch {
      // Ignore download failures and fall through to the next file.
    }
  }
  return null;
}

export type SlackThreadStarter = {
  text: string;
  userId?: string;
  ts?: string;
  files?: SlackFile[];
};

export type SlackThreadReply = {
  text: string;
  userId?: string;
  ts?: string;
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

/**
 * Fetches recent thread replies (excluding the thread starter and a specific message).
 * Returns messages in chronological order (oldest first).
 */
export async function resolveSlackThreadReplies(params: {
  channelId: string;
  threadTs: string;
  client: SlackWebClient;
  /** Message ts to exclude (usually the current inbound message). */
  excludeTs?: string;
  /** Maximum number of replies to fetch (default: 10). */
  limit?: number;
}): Promise<SlackThreadReply[]> {
  const limit = params.limit ?? 10;
  try {
    const response = (await params.client.conversations.replies({
      channel: params.channelId,
      ts: params.threadTs,
      // Fetch more than limit to account for exclusions.
      limit: limit + 2,
      inclusive: true,
    })) as { messages?: Array<{ text?: string; user?: string; ts?: string }> };
    const messages = response?.messages ?? [];
    // Filter out the thread starter (first message) and the excluded message.
    const replies = messages
      .filter((msg) => {
        if (!msg.ts) return false;
        // Exclude thread starter (ts === threadTs).
        if (msg.ts === params.threadTs) return false;
        // Exclude the specified message (usually the current inbound).
        if (params.excludeTs && msg.ts === params.excludeTs) return false;
        return true;
      })
      .map((msg) => ({
        text: (msg.text ?? "").trim(),
        userId: msg.user,
        ts: msg.ts,
      }))
      .filter((reply) => reply.text.length > 0);
    // Return in chronological order, limited to the specified count.
    // conversations.replies returns messages in chronological order by default.
    return replies.slice(-limit);
  } catch {
    return [];
  }
}
