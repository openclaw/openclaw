import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { HookMessageChannel } from "./hooks.js";
import { readJsonBody } from "./hooks.js";
import { getWebhookTransform } from "./webhook-transforms/index.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

const WEBHOOKS_PREFIX = "/webhooks/";

export type WebhooksConfigResolved = {
  token: string;
  presets: string[];
  maxBodyBytes: number;
  rawMode: string[];
};

export type WebhooksRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean>;

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function extractRawSessionKey(payload: Record<string, unknown>, source: string): string {
  const id =
    (payload.entity_id as string | number | undefined) ??
    (payload.id as string | number | undefined) ??
    (payload.session_id as string | number | undefined);
  return `webhook:${source}:${id ?? "unknown"}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function constantTimeTokenMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf-8");
  const b = Buffer.from(expected, "utf-8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

export function createWebhooksRequestHandler(opts: {
  getWebhooksConfig: () => WebhooksConfigResolved | null;
  bindHost: string;
  port: number;
  logWebhooks: SubsystemLogger;
  dispatchAgentHook: (value: {
    message: string;
    name: string;
    wakeMode: "now" | "next-heartbeat";
    sessionKey: string;
    deliver: boolean;
    channel: HookMessageChannel;
    to?: string;
    model?: string;
    thinking?: string;
    timeoutSeconds?: number;
    allowUnsafeExternalContent?: boolean;
  }) => string;
}): WebhooksRequestHandler {
  const { getWebhooksConfig, bindHost, port, logWebhooks, dispatchAgentHook } = opts;

  return async (req, res) => {
    const webhooksConfig = getWebhooksConfig();
    if (!webhooksConfig) {
      return false;
    }

    const url = new URL(req.url ?? "/", `http://${bindHost}:${port}`);
    if (!url.pathname.startsWith(WEBHOOKS_PREFIX)) {
      return false;
    }

    // Parse /webhooks/{token}/{source}
    const rest = url.pathname.slice(WEBHOOKS_PREFIX.length);
    const slashIndex = rest.indexOf("/");
    if (slashIndex < 0) {
      // No source segment — return 404
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not Found");
      return true;
    }

    const token = rest.slice(0, slashIndex);
    const source = rest.slice(slashIndex + 1).replace(/\/+$/, "");

    if (!token || !source) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not Found");
      return true;
    }

    // Validate token with constant-time comparison
    if (!constantTimeTokenMatch(token, webhooksConfig.token)) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not Found");
      return true;
    }

    // POST only
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }

    // Check source is an enabled preset
    if (!webhooksConfig.presets.includes(source)) {
      logWebhooks.warn(`webhook source "${source}" is not an enabled preset`);
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not Found");
      return true;
    }

    const rawModeEnabled = webhooksConfig.rawMode.includes(source);

    // Look up transform (required unless rawMode is enabled for this source)
    const transform = getWebhookTransform(source);
    if (!transform && !rawModeEnabled) {
      logWebhooks.warn(`no transform found for webhook source "${source}"`);
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not Found");
      return true;
    }

    // Parse JSON body
    const body = await readJsonBody(req, webhooksConfig.maxBodyBytes);
    if (!body.ok) {
      const status = body.error === "payload too large" ? 413 : 400;
      sendJson(res, status, { ok: false, error: body.error });
      return true;
    }

    const payload =
      typeof body.value === "object" && body.value !== null
        ? (body.value as Record<string, unknown>)
        : {};

    let message: string;
    let sessionKey: string;
    let name: string;

    if (rawModeEnabled) {
      message = JSON.stringify(payload, null, 2);
      sessionKey = extractRawSessionKey(payload, source);
      name = capitalize(source);
    } else {
      // Transform payload
      const result = transform!(payload);
      if (result === null) {
        // Transform says skip (e.g., non-meeting_end trigger)
        sendJson(res, 200, { ok: true, skipped: true });
        return true;
      }
      message = result.message;
      sessionKey = result.sessionKey;
      name = result.name;
    }

    // Dispatch to agent
    const runId = dispatchAgentHook({
      message,
      name,
      wakeMode: "now",
      sessionKey,
      deliver: true,
      channel: "last",
    });

    logWebhooks.info(`webhook dispatched: source=${source} runId=${runId}`);
    sendJson(res, 200, { ok: true, runId });
    return true;
  };
}
