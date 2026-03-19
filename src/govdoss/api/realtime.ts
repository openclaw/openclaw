import type { Response } from "express";
import { govdossAuditStore } from "../audit-store.js";

const clients = new Set<Response>();

export function registerRealtimeClient(res: Response) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  clients.add(res);

  res.on("close", () => {
    clients.delete(res);
  });
}

export function broadcastRealtimeEvent(event: unknown) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    try {
      client.write(payload);
    } catch {
      clients.delete(client);
    }
  }
}

export function emitAuditEvent(record: any) {
  govdossAuditStore.append(record);
  broadcastRealtimeEvent({ type: "audit", record });
}
