import type { WebClient as SlackWebClient } from "@slack/web-api";
import type { FetchLike } from "../../media/fetch.js";
import type { SlackFile } from "../types.js";
import { logWarn } from "../../logger.js";
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
 * Detects if buffer content looks like an HTML login/error page.
 * Slack sometimes returns HTML login pages when auth fails instead of binary media.
 * Only use leading-whitespace trim to keep prefix checks stable for binary content.
 */
function looksLikeHtmlBuffer(buffer: Buffer): boolean {
  const head = buffer.subarray(0, 512).toString("utf-8").replace(/^\s+/, "").toLowerCase();
  // Check for standard HTML document markers at the start of the content.
  return head.startsWith("<!doctype html") || head.startsWith("<html");
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

      // Guard: reject if we received HTML instead of expected media.
      // This happens when Slack auth fails and returns a login page.
      // Skip this check if the file is explicitly an HTML file (user-uploaded .html).
      const fileMime = file.mimetype?.toLowerCase();
      const fileName = file.name?.toLowerCase() ?? "";
      const isExpectedHtml =
        fileMime === "text/html" || fileName.endsWith(".html") || fileName.endsWith(".htm");
      if (!isExpectedHtml) {
        const detectedMime = fetched.contentType?.split(";")[0]?.trim().toLowerCase();
        if (detectedMime === "text/html" || looksLikeHtmlBuffer(fetched.buffer)) {
          const fileId = file.name ?? file.id ?? "unknown";
          logWarn(
            `slack: received HTML instead of media for file ${fileId}; possible auth failure or expired URL`,
          );
          continue;
        }
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
