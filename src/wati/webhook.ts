import * as crypto from "node:crypto";
import * as http from "node:http";

export type WatiInboundMessage = {
  messageId: string;
  from: string;
  text: string;
  senderName: string;
  timestamp: number;
  messageType: string;
};

export type WatiWebhookOpts = {
  port: number;
  path: string;
  host?: string;
  onMessage: (msg: WatiInboundMessage) => void;
  abortSignal?: AbortSignal;
  webhookSecret?: string;
};

/**
 * Start an HTTP server to receive WATI webhook callbacks.
 * Handles GET (verification) and POST (incoming messages).
 */
export function startWatiWebhook(opts: WatiWebhookOpts): {
  server: http.Server;
  close: () => Promise<void>;
} {
  const server = http.createServer((req, res) => {
    if (!req.url?.startsWith(opts.path)) {
      res.writeHead(404).end();
      return;
    }

    if (req.method === "GET") {
      handleVerification(req, res, opts.port);
      return;
    }

    if (req.method === "POST") {
      handleIncoming(req, res, opts.onMessage, opts.webhookSecret);
      return;
    }

    res.writeHead(405).end();
  });

  const host = opts.host || "0.0.0.0";
  server.listen(opts.port, host);

  if (opts.abortSignal) {
    const onAbort = () => {
      server.close();
    };
    opts.abortSignal.addEventListener("abort", onAbort, { once: true });
  }

  const close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });

  return { server, close };
}

function handleVerification(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  port: number,
): void {
  const url = new URL(req.url!, `http://localhost:${port}`);
  const challenge = url.searchParams.get("hub.challenge");
  if (challenge) {
    res.writeHead(200, { "Content-Type": "text/plain" }).end(challenge);
  } else {
    res.writeHead(200).end("ok");
  }
}

function handleIncoming(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  onMessage: (msg: WatiInboundMessage) => void,
  webhookSecret?: string,
): void {
  let body = "";
  req.on("data", (chunk: Buffer) => {
    body += chunk.toString();
  });
  req.on("end", () => {
    // Validate webhook signature when a secret is configured
    if (webhookSecret) {
      const signature = req.headers["x-hub-signature-256"] || req.headers["x-wati-signature"];
      if (!signature) {
        res.writeHead(401).end("Missing signature");
        return;
      }
      const expected =
        "sha256=" + crypto.createHmac("sha256", webhookSecret).update(body).digest("hex");
      if (!crypto.timingSafeEqual(Buffer.from(String(signature)), Buffer.from(expected))) {
        res.writeHead(403).end("Invalid signature");
        return;
      }
    }

    res.writeHead(200).end("ok");

    try {
      const payload = JSON.parse(body) as Record<string, unknown>;

      // WATI sends different payload structures — normalize all variants
      const text =
        (payload.text as string) ||
        ((payload.message as Record<string, unknown>)?.text as string) ||
        ((payload.message as Record<string, unknown>)?.body as string) ||
        "";
      const waId =
        (payload.waId as string) || (payload.wa_id as string) || (payload.from as string) || "";
      const messageId =
        (payload.whatsappMessageId as string) ||
        (payload.message_id as string) ||
        (payload.id as string) ||
        "";
      const senderName =
        (payload.senderName as string) ||
        (payload.sender_name as string) ||
        (payload.pushName as string) ||
        "";
      const timestamp = payload.timestamp || payload.created || "";
      // WATI API uses different field names across versions:
      //   fromMe (v2+), from_me (v1 legacy), owner (older webhook format)
      const fromMe = payload.fromMe ?? payload.from_me ?? payload.owner ?? false;
      const messageType = (payload.type as string) || (payload.messageType as string) || "text";

      if (!text || fromMe) {
        return;
      }

      const ts = String(timestamp as string | number | undefined);
      const parsedTs = ts
        ? new Date(/^\d+$/.test(ts) ? Number(ts) * (/^\d{10}$/.test(ts) ? 1000 : 1) : ts).getTime()
        : NaN;

      onMessage({
        messageId,
        from: waId,
        text,
        senderName,
        timestamp: Number.isFinite(parsedTs) ? parsedTs : Date.now(),
        messageType,
      });
    } catch {
      // Silently ignore unparseable payloads
    }
  });
}
