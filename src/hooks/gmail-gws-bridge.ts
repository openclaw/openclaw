/**
 * Gmail GWS Bridge
 *
 * Transforms gws gmail +watch NDJSON output into the hook payload format
 * expected by the gmail hook preset: `{ messages: [{ id, from, subject, snippet, body }] }`.
 *
 * gws outputs one JSON object per line (NDJSON) for each new email.
 */

import { createSubsystemLogger, type SubsystemLogger } from "../logging/subsystem.js";

export type GmailHookMessage = {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  body: string;
};

export type GmailHookPayload = {
  messages: GmailHookMessage[];
};

/**
 * Extract a header value from a Gmail API message's payload headers array.
 */
function extractHeader(
  headers: Array<{ name?: string; value?: string }> | undefined,
  name: string,
): string {
  if (!headers) {
    return "";
  }
  const lower = name.toLowerCase();
  const entry = headers.find((h) => h.name?.toLowerCase() === lower);
  return entry?.value ?? "";
}

/**
 * Decode base64url-encoded string (Gmail API uses URL-safe base64).
 */
function decodeBase64Url(encoded: string): string {
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf-8");
}

/**
 * Recursively find the first text/plain body part in a Gmail API message payload.
 */
function findTextBody(
  payload: { mimeType?: string; body?: { data?: string }; parts?: unknown[] } | undefined,
): string {
  if (!payload) {
    return "";
  }
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  if (Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      const found = findTextBody(part as typeof payload);
      if (found) {
        return found;
      }
    }
  }
  return "";
}

export type TransformOptions = {
  includeBody?: boolean;
  maxBytes?: number;
};

/**
 * Transform a Gmail API message object (as returned by gws) into
 * the hook payload format expected by the gmail preset.
 */
export function transformGmailApiMessage(
  msg: Record<string, unknown>,
  opts?: TransformOptions,
): GmailHookPayload {
  const id = typeof msg.id === "string" ? msg.id : "";
  const snippet = typeof msg.snippet === "string" ? msg.snippet : "";

  const payload = msg.payload as
    | {
        headers?: Array<{ name?: string; value?: string }>;
        mimeType?: string;
        body?: { data?: string };
        parts?: unknown[];
      }
    | undefined;

  const from = extractHeader(payload?.headers, "From");
  const subject = extractHeader(payload?.headers, "Subject");

  let body = "";
  if (opts?.includeBody !== false) {
    body = findTextBody(payload);
    const maxBytes = opts?.maxBytes;
    if (maxBytes && maxBytes > 0 && body.length > maxBytes) {
      body = body.slice(0, maxBytes);
    }
  }

  return {
    messages: [{ id, from, subject, snippet, body }],
  };
}

/**
 * POST a hook payload to the OpenClaw hook URL.
 */
export async function postToHookUrl(
  payload: GmailHookPayload,
  hookUrl: string,
  hookToken: string,
): Promise<void> {
  const response = await fetch(hookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${hookToken}`,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Hook POST failed: ${response.status} ${response.statusText}`);
  }
}

export type NdjsonLineHandlerConfig = {
  hookUrl: string;
  hookToken: string;
  includeBody: boolean;
  maxBytes: number;
};

/**
 * Create a callback that processes a single NDJSON line from gws stdout,
 * transforms it into a hook payload, and POSTs it.
 */
export function createNdjsonLineHandler(
  cfg: NdjsonLineHandlerConfig,
  log?: SubsystemLogger,
): (line: string) => void {
  const logger = log ?? createSubsystemLogger("gmail-gws-bridge");

  return (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      logger.warn(`ignoring non-JSON line: ${trimmed.slice(0, 120)}`);
      return;
    }

    const payload = transformGmailApiMessage(msg, {
      includeBody: cfg.includeBody,
      maxBytes: cfg.maxBytes,
    });

    const id = payload.messages[0]?.id ?? "?";
    logger.info(`forwarding message ${id} to ${cfg.hookUrl}`);

    void postToHookUrl(payload, cfg.hookUrl, cfg.hookToken).catch((err) => {
      logger.error(`failed to forward message ${id}: ${String(err)}`);
    });
  };
}
