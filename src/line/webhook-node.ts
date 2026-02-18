import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebhookRequestBody } from "@line/bot-sdk";
import { danger, logVerbose } from "../globals.js";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "../infra/http-body.js";
import type { RuntimeEnv } from "../runtime.js";
import { validateLineSignature } from "./signature.js";
import { isLineWebhookVerificationRequest, parseLineWebhookBody } from "./webhook-utils.js";

const LINE_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const LINE_WEBHOOK_BODY_TIMEOUT_MS = 30_000;

export async function readLineWebhookRequestBody(
  req: IncomingMessage,
  maxBytes = LINE_WEBHOOK_MAX_BODY_BYTES,
): Promise<string> {
  return await readRequestBodyWithLimit(req, {
    maxBytes,
    timeoutMs: LINE_WEBHOOK_BODY_TIMEOUT_MS,
  });
}

type ReadBodyFn = (req: IncomingMessage, maxBytes: number) => Promise<string>;

export function createLineNodeWebhookHandler(params: {
  channelSecret: string;
  bot: { handleWebhook: (body: WebhookRequestBody) => Promise<void> };
  runtime: RuntimeEnv;
  readBody?: ReadBodyFn;
  maxBodyBytes?: number;
}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const maxBodyBytes = params.maxBodyBytes ?? LINE_WEBHOOK_MAX_BODY_BYTES;
  const readBody = params.readBody ?? readLineWebhookRequestBody;

  return async (req: IncomingMessage, res: ServerResponse) => {
    // Handle GET requests for webhook verification
    if (req.method === "GET") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain");
      res.end("OK");
      return;
    }

    // Only accept POST requests
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET, POST");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Method Not Allowed" }));
      return;
    }

    try {
      const rawBody = await readBody(req, maxBodyBytes);
      const signature = req.headers["x-line-signature"];

      // Parse once; we may need it for verification requests and for event processing.
      const body = parseLineWebhookBody(rawBody);

      // LINE webhook verification sends POST {"events":[]} without a
      // signature header. Return 200 so the LINE Developers Console
      // "Verify" button succeeds.
      if (!signature || typeof signature !== "string") {
        if (isLineWebhookVerificationRequest(body)) {
          logVerbose("line: webhook verification request (empty events, no signature) - 200 OK");
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ status: "ok" }));
          return;
        }
        logVerbose("line: webhook missing X-Line-Signature header");
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Missing X-Line-Signature header" }));
        return;
      }

      if (!validateLineSignature(rawBody, signature, params.channelSecret)) {
        logVerbose("line: webhook signature validation failed");
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Invalid signature" }));
        return;
      }

      if (!body) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Invalid webhook payload" }));
        return;
      }

      // Process events before acknowledging delivery so failures can retry upstream.
      if (body.events && body.events.length > 0) {
        logVerbose(`line: received ${body.events.length} webhook events`);
        await params.bot.handleWebhook(body);
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ status: "ok" }));
    } catch (err) {
      if (isRequestBodyLimitError(err, "PAYLOAD_TOO_LARGE")) {
        res.statusCode = 413;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Payload too large" }));
        return;
      }
      if (isRequestBodyLimitError(err, "REQUEST_BODY_TIMEOUT")) {
        res.statusCode = 408;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: requestBodyErrorToText("REQUEST_BODY_TIMEOUT") }));
        return;
      }
      params.runtime.error?.(danger(`line webhook error: ${String(err)}`));
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  };
}
