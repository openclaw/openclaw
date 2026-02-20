import type { IncomingMessage, ServerResponse } from "node:http";
import { verifySlackRequestSignature } from "./verify.js";

export type SlackHttpRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void> | void;

type SlackHttpRoute = {
  handler: SlackHttpRequestHandler;
  /**
   * Slack app signing secret used to verify X-Slack-Signature on incoming
   * requests. When present, the registry performs a timestamp staleness check
   * before dispatching to the handler (fast pre-rejection without reading the
   * body). Full HMAC verification must still be performed by the handler, or
   * by wrapping with {@link withSlackSignatureVerification}.
   *
   * Security note: all HTTP-mode Slack routes SHOULD supply a signingSecret so
   * that replayed / stale requests are rejected at the routing layer even before
   * the handler reads the body.
   */
  signingSecret?: string;
};

type RegisterSlackHttpHandlerArgs = {
  path?: string | null;
  handler: SlackHttpRequestHandler;
  /**
   * Slack app signing secret for this route. When provided the registry will
   * reject requests with a stale or missing X-Slack-Request-Timestamp header
   * before forwarding to the handler.
   */
  signingSecret?: string;
  log?: (message: string) => void;
  accountId?: string;
};

const slackHttpRoutes = new Map<string, SlackHttpRoute>();

export function normalizeSlackWebhookPath(path?: string | null): string {
  const trimmed = path?.trim();
  if (!trimmed) {
    return "/slack/events";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function registerSlackHttpHandler(params: RegisterSlackHttpHandlerArgs): () => void {
  const normalizedPath = normalizeSlackWebhookPath(params.path);
  if (slackHttpRoutes.has(normalizedPath)) {
    const suffix = params.accountId ? ` for account "${params.accountId}"` : "";
    params.log?.(`slack: webhook path ${normalizedPath} already registered${suffix}`);
    return () => {};
  }
  slackHttpRoutes.set(normalizedPath, {
    handler: params.handler,
    signingSecret: params.signingSecret,
  });
  return () => {
    slackHttpRoutes.delete(normalizedPath);
  };
}

export async function handleSlackHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = slackHttpRoutes.get(url.pathname);
  if (!route) {
    return false;
  }

  // Fast pre-rejection: if a signing secret is registered for this route,
  // check the timestamp header before the body is read. This prevents the
  // handler from processing obviously stale or replayed requests at zero cost.
  // Full HMAC verification (which requires the body) is the handler's
  // responsibility — see withSlackSignatureVerification().
  if (route.signingSecret) {
    const timestampResult = verifySlackRequestSignature({
      signingSecret: route.signingSecret,
      body: "", // body not yet read; we only need the timestamp check here
      timestamp: req.headers["x-slack-request-timestamp"] as string | undefined,
      signature: req.headers["x-slack-signature"] as string | undefined,
    });
    // Reject on missing/stale timestamp. An invalid HMAC at this stage is
    // expected (body is empty), so only surface timestamp-related failures.
    if (
      !timestampResult.ok &&
      (timestampResult.reason.includes("Timestamp") ||
        timestampResult.reason.includes("timestamp") ||
        timestampResult.reason.includes("Missing X-Slack-Request-Timestamp") ||
        timestampResult.reason.includes("Missing X-Slack-Signature"))
    ) {
      res.writeHead(timestampResult.statusCode, { "Content-Type": "text/plain" });
      res.end(timestampResult.reason);
      return true;
    }
  }

  await route.handler(req, res);
  return true;
}
