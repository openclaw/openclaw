import type { IncomingMessage, ServerResponse } from "node:http";
import { logInfo } from "../logger.js";
import { handleWebhook as handlePaystackWebhook, verifyWebhookSignature } from "../integrations/paystack/paystack-service.js";
import { verifyWebhookChallenge, handleWebhook as handleWhatsAppWebhook } from "../integrations/whatsapp/whatsapp-service.js";

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => body += chunk.toString());
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

export async function handleWebhookRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (!url.pathname.startsWith("/webhooks/")) return false;

  logInfo(`Webhook: ${req.method} ${url.pathname}`);

  // Termii webhook
  if (url.pathname === "/webhooks/termii" && req.method === "POST") {
    await readBody(req);
    sendJson(res, 200, { received: true });
    return true;
  }

  // Paystack webhook
  if (url.pathname === "/webhooks/paystack" && req.method === "POST") {
    const body = await readBody(req);
    const signature = req.headers["x-paystack-signature"] as string;
    if (!signature || !verifyWebhookSignature(body, signature)) {
      sendJson(res, 200, { received: true }); // Always 200 to prevent retries
      return true;
    }
    await handlePaystackWebhook(body, signature);
    sendJson(res, 200, { received: true });
    return true;
  }

  // WhatsApp verification (GET)
  if (url.pathname === "/webhooks/whatsapp" && req.method === "GET") {
    const mode = url.searchParams.get("hub.mode") || "";
    const token = url.searchParams.get("hub.verify_token") || "";
    const challenge = url.searchParams.get("hub.challenge") || "";
    const result = verifyWebhookChallenge(mode, token, challenge);
    if (result.success) {
      res.statusCode = 200;
      res.end(result.challenge);
    } else {
      sendJson(res, 403, { error: result.error });
    }
    return true;
  }

  // WhatsApp messages (POST)
  if (url.pathname === "/webhooks/whatsapp" && req.method === "POST") {
    const body = await readBody(req);
    await handleWhatsAppWebhook(JSON.parse(body));
    sendJson(res, 200, { received: true });
    return true;
  }

  sendJson(res, 404, { error: "Webhook not found" });
  return true;
}
