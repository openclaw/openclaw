import type { WebhookRequestBody } from "@line/bot-sdk";
import type { Request, Response, NextFunction } from "express";
import { logVerbose, danger } from "../globals.js";
import type { RuntimeEnv } from "../runtime.js";
import { validateLineSignature } from "./signature.js";
import { isLineWebhookVerificationRequest, parseLineWebhookBody } from "./webhook-utils.js";

export interface LineWebhookOptions {
  channelSecret: string;
  onEvents: (body: WebhookRequestBody) => Promise<void>;
  runtime?: RuntimeEnv;
}

function readRawBody(req: Request): string | null {
  const rawBody =
    (req as { rawBody?: string | Buffer }).rawBody ??
    (typeof req.body === "string" || Buffer.isBuffer(req.body) ? req.body : null);
  if (!rawBody) {
    return null;
  }
  return Buffer.isBuffer(rawBody) ? rawBody.toString("utf-8") : rawBody;
}

function parseWebhookBody(req: Request, rawBody?: string | null): WebhookRequestBody | null {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    return req.body as WebhookRequestBody;
  }
  if (!rawBody) {
    return null;
  }
  return parseLineWebhookBody(rawBody);
}

export function createLineWebhookMiddleware(
  options: LineWebhookOptions,
): (req: Request, res: Response, _next: NextFunction) => Promise<void> {
  const { channelSecret, onEvents, runtime } = options;

  return async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    try {
      const signature = req.headers["x-line-signature"];
      const rawBody = readRawBody(req);
      const body = parseWebhookBody(req, rawBody);

      // LINE webhook verification sends POST {"events":[]} without a
      // signature header.  Return 200 immediately so the LINE Developers
      // Console "Verify" button succeeds.
      if (!signature || typeof signature !== "string") {
        if (isLineWebhookVerificationRequest(body)) {
          logVerbose("line: webhook verification request (empty events, no signature) - 200 OK");
          res.status(200).json({ status: "ok" });
          return;
        }
        res.status(400).json({ error: "Missing X-Line-Signature header" });
        return;
      }

      if (!rawBody) {
        res.status(400).json({ error: "Missing raw request body for signature verification" });
        return;
      }

      if (!validateLineSignature(rawBody, signature, channelSecret)) {
        logVerbose("line: webhook signature validation failed");
        res.status(401).json({ error: "Invalid signature" });
        return;
      }

      if (!body) {
        res.status(400).json({ error: "Invalid webhook payload" });
        return;
      }

      // Respond immediately to avoid timeout
      res.status(200).json({ status: "ok" });

      // Process events asynchronously
      if (body.events && body.events.length > 0) {
        logVerbose(`line: received ${body.events.length} webhook events`);
        await onEvents(body).catch((err) => {
          runtime?.error?.(danger(`line webhook handler failed: ${String(err)}`));
        });
      }
    } catch (err) {
      runtime?.error?.(danger(`line webhook error: ${String(err)}`));
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  };
}

export interface StartLineWebhookOptions {
  channelSecret: string;
  onEvents: (body: WebhookRequestBody) => Promise<void>;
  runtime?: RuntimeEnv;
  path?: string;
}

export function startLineWebhook(options: StartLineWebhookOptions): {
  path: string;
  handler: (req: Request, res: Response, _next: NextFunction) => Promise<void>;
} {
  const path = options.path ?? "/line/webhook";
  const middleware = createLineWebhookMiddleware({
    channelSecret: options.channelSecret,
    onEvents: options.onEvents,
    runtime: options.runtime,
  });

  return { path, handler: middleware };
}
