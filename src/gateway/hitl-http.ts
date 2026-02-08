import type { IncomingMessage, ServerResponse } from "node:http";
import { hitlApprovalManager } from "../infra/hitl/state.js";
import { parseHitlWebhookPayload } from "../infra/hitl/types.js";
import { readJsonBody } from "./hooks.js";

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export async function handleHitlCallbackHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { callbackSecret: string; maxBodyBytes: number },
): Promise<boolean> {
  const secret = opts.callbackSecret.trim();
  if (!secret) {
    return false;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const expectedPath = `/hitl/callback/${secret}`;
  if (url.pathname !== expectedPath) {
    return false;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  const body = await readJsonBody(req, opts.maxBodyBytes);
  if (!body.ok) {
    const status = body.error === "payload too large" ? 413 : 400;
    sendJson(res, status, { ok: false, error: body.error });
    return true;
  }
  const parsed = parseHitlWebhookPayload(body.value);
  if (!parsed.ok) {
    sendJson(res, 400, { ok: false, error: parsed.error });
    return true;
  }

  if (parsed.value.kind === "completed") {
    const resolved = hitlApprovalManager.resolveByHitlRequestId({
      hitlRequestId: parsed.value.requestId,
      decision: parsed.value.decision,
      resolvedBy: parsed.value.resolvedBy,
    });
    sendJson(res, 200, { ok: true, resolved });
    return true;
  }

  if (parsed.value.kind === "default") {
    const resolved = hitlApprovalManager.resolveDefaultByHitlRequestId({
      hitlRequestId: parsed.value.requestId,
      resolvedBy: parsed.value.resolvedBy,
    });
    sendJson(res, 200, { ok: true, resolved, event: parsed.value.event });
    return true;
  }

  sendJson(res, 200, { ok: true, resolved: false, ignored: parsed.value.reason });
  return true;
}
