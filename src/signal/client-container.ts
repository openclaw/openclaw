/**
 * Signal client for bbernhard/signal-cli-rest-api container.
 * Uses WebSocket for receiving messages and REST API for sending.
 *
 * This is a separate implementation from client.ts (native signal-cli)
 * to keep the two modes cleanly isolated.
 */

import fs from "node:fs/promises";
import nodePath from "node:path";
import WebSocket from "ws";
import { resolveFetch } from "../infra/fetch.js";
import { detectMime } from "../media/mime.js";

export type ContainerRpcOptions = {
  baseUrl: string;
  timeoutMs?: number;
};

export type ContainerWebSocketMessage = {
  envelope?: {
    syncMessage?: unknown;
    dataMessage?: {
      message?: string;
      groupInfo?: { groupId?: string; groupName?: string };
      attachments?: Array<{
        id?: string;
        contentType?: string;
        filename?: string;
        size?: number;
      }>;
      quote?: { text?: string };
      reaction?: unknown;
    };
    editMessage?: { dataMessage?: unknown };
    reactionMessage?: unknown;
    sourceNumber?: string;
    sourceUuid?: string;
    sourceName?: string;
    timestamp?: number;
  };
  exception?: { message?: string };
};

const DEFAULT_TIMEOUT_MS = 10_000;

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new Error("Signal base URL is required");
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\/+$/, "");
  }
  return `http://${trimmed}`.replace(/\/+$/, "");
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const fetchImpl = resolveFetch();
  if (!fetchImpl) {
    throw new Error("fetch is not available");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check if bbernhard container REST API is available.
 */
export async function containerCheck(
  baseUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ ok: boolean; status?: number | null; error?: string | null }> {
  const normalized = normalizeBaseUrl(baseUrl);
  try {
    const res = await fetchWithTimeout(`${normalized}/v1/about`, { method: "GET" }, timeoutMs);
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status, error: null };
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Make a REST API request to bbernhard container.
 */
export async function containerRestRequest<T = unknown>(
  endpoint: string,
  opts: ContainerRpcOptions,
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
  body?: unknown,
): Promise<T> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const url = `${baseUrl}${endpoint}`;

  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };

  if (body) {
    init.body = JSON.stringify(body);
  }

  const res = await fetchWithTimeout(url, init, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  if (res.status === 201 || res.status === 204) {
    return undefined as T;
  }

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(`Signal REST ${res.status}: ${errorText || res.statusText}`);
  }

  const text = await res.text();
  if (!text) {
    return undefined as T;
  }

  return JSON.parse(text) as T;
}

/**
 * Fetch attachment binary from bbernhard container.
 */
export async function containerFetchAttachment(
  attachmentId: string,
  opts: ContainerRpcOptions,
): Promise<Buffer | null> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const url = `${baseUrl}/v1/attachments/${encodeURIComponent(attachmentId)}`;

  const res = await fetchWithTimeout(url, { method: "GET" }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  if (!res.ok) {
    return null;
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Stream messages using WebSocket from bbernhard container.
 * The Promise resolves when the connection closes (for any reason).
 * The caller (runSignalLoopAdapter) is responsible for reconnection.
 */
export async function streamContainerEvents(params: {
  baseUrl: string;
  account?: string;
  abortSignal?: AbortSignal;
  onEvent: (event: ContainerWebSocketMessage) => void;
  logger?: { log?: (msg: string) => void; error?: (msg: string) => void };
}): Promise<void> {
  const normalized = normalizeBaseUrl(params.baseUrl);
  const wsUrl = `${normalized.replace(/^http/, "ws")}/v1/receive/${encodeURIComponent(params.account ?? "")}`;
  const log = params.logger?.log ?? (() => {});
  const logError = params.logger?.error ?? (() => {});

  log(`[signal-ws] connecting to ${wsUrl}`);

  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    let resolved = false;

    const cleanup = () => {
      if (resolved) {
        return;
      }
      resolved = true;
    };

    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      logError(
        `[signal-ws] failed to create WebSocket: ${err instanceof Error ? err.message : String(err)}`,
      );
      reject(err);
      return;
    }

    ws.on("open", () => {
      log("[signal-ws] connected");
    });

    ws.on("message", (data: Buffer) => {
      try {
        const text = data.toString();
        log(`[signal-ws] received: ${text.slice(0, 200)}${text.length > 200 ? "..." : ""}`);
        const envelope = JSON.parse(text) as ContainerWebSocketMessage;
        if (envelope) {
          params.onEvent(envelope);
        }
      } catch (err) {
        logError(`[signal-ws] parse error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    ws.on("error", (err) => {
      logError(`[signal-ws] error: ${err instanceof Error ? err.message : String(err)}`);
      // Don't resolve here - the close event will fire next
    });

    ws.on("close", (code, reason) => {
      const reasonStr = reason?.toString() || "no reason";
      log(`[signal-ws] closed (code=${code}, reason=${reasonStr})`);
      cleanup();
      resolve(); // Let the outer loop handle reconnection
    });

    ws.on("ping", () => {
      log("[signal-ws] ping received");
    });

    ws.on("pong", () => {
      log("[signal-ws] pong received");
    });

    params.abortSignal?.addEventListener(
      "abort",
      () => {
        log("[signal-ws] aborted, closing connection");
        cleanup();
        ws.close();
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Convert local file paths to base64 data URIs for the container REST API.
 * The bbernhard container /v2/send only accepts `base64_attachments` (not file paths).
 */
async function filesToBase64DataUris(filePaths: string[]): Promise<string[]> {
  const results: string[] = [];
  for (const filePath of filePaths) {
    const buffer = await fs.readFile(filePath);
    const mime = (await detectMime({ buffer, filePath })) ?? "application/octet-stream";
    const filename = nodePath.basename(filePath);
    const b64 = buffer.toString("base64");
    results.push(`data:${mime};filename=${filename};base64,${b64}`);
  }
  return results;
}

/**
 * Send message via bbernhard container REST API.
 */
export async function containerSendMessage(params: {
  baseUrl: string;
  account: string;
  recipients: string[];
  message: string;
  textStyles?: Array<{ start: number; length: number; style: string }>;
  attachments?: string[];
  timeoutMs?: number;
}): Promise<{ timestamp?: number }> {
  const payload: Record<string, unknown> = {
    message: params.message,
    number: params.account,
    recipients: params.recipients,
  };

  if (params.textStyles && params.textStyles.length > 0) {
    payload["text_style"] = params.textStyles.map(
      (style) => `${style.start}:${style.length}:${style.style}`,
    );
  }

  if (params.attachments && params.attachments.length > 0) {
    // Container API only accepts base64-encoded attachments, not file paths.
    payload.base64_attachments = await filesToBase64DataUris(params.attachments);
  }

  const result = await containerRestRequest<{ timestamp?: number }>(
    "/v2/send",
    { baseUrl: params.baseUrl, timeoutMs: params.timeoutMs },
    "POST",
    payload,
  );

  return result ?? {};
}

/**
 * Send typing indicator via bbernhard container REST API.
 */
export async function containerSendTyping(params: {
  baseUrl: string;
  account: string;
  recipient: string;
  stop?: boolean;
  timeoutMs?: number;
}): Promise<boolean> {
  const method = params.stop ? "DELETE" : "PUT";
  await containerRestRequest(
    `/v1/typing-indicator/${encodeURIComponent(params.account)}`,
    { baseUrl: params.baseUrl, timeoutMs: params.timeoutMs },
    method,
    { recipient: params.recipient },
  );
  return true;
}

/**
 * Send read receipt via bbernhard container REST API.
 */
export async function containerSendReceipt(params: {
  baseUrl: string;
  account: string;
  recipient: string;
  timestamp: number;
  type?: "read" | "viewed";
  timeoutMs?: number;
}): Promise<boolean> {
  await containerRestRequest(
    `/v1/receipts/${encodeURIComponent(params.account)}`,
    { baseUrl: params.baseUrl, timeoutMs: params.timeoutMs },
    "POST",
    {
      recipient: params.recipient,
      timestamp: params.timestamp,
      receipt_type: params.type ?? "read",
    },
  );
  return true;
}

/**
 * Send a reaction to a message via bbernhard container REST API.
 */
export async function containerSendReaction(params: {
  baseUrl: string;
  account: string;
  recipient: string;
  emoji: string;
  targetAuthor: string;
  targetTimestamp: number;
  groupId?: string;
  timeoutMs?: number;
}): Promise<{ timestamp?: number }> {
  const payload: Record<string, unknown> = {
    recipient: params.recipient,
    reaction: params.emoji,
    target_author: params.targetAuthor,
    timestamp: params.targetTimestamp,
  };

  if (params.groupId) {
    payload.group_id = params.groupId;
  }

  const result = await containerRestRequest<{ timestamp?: number }>(
    `/v1/reactions/${encodeURIComponent(params.account)}`,
    { baseUrl: params.baseUrl, timeoutMs: params.timeoutMs },
    "POST",
    payload,
  );

  return result ?? {};
}

/**
 * Remove a reaction from a message via bbernhard container REST API.
 */
export async function containerRemoveReaction(params: {
  baseUrl: string;
  account: string;
  recipient: string;
  emoji: string;
  targetAuthor: string;
  targetTimestamp: number;
  groupId?: string;
  timeoutMs?: number;
}): Promise<{ timestamp?: number }> {
  const payload: Record<string, unknown> = {
    recipient: params.recipient,
    reaction: params.emoji,
    target_author: params.targetAuthor,
    timestamp: params.targetTimestamp,
  };

  if (params.groupId) {
    payload.group_id = params.groupId;
  }

  const result = await containerRestRequest<{ timestamp?: number }>(
    `/v1/reactions/${encodeURIComponent(params.account)}`,
    { baseUrl: params.baseUrl, timeoutMs: params.timeoutMs },
    "DELETE",
    payload,
  );

  return result ?? {};
}
