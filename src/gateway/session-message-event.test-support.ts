import { expect } from "vitest";
import type { WebSocket } from "ws";
import { onceMessage } from "./test-helpers.server.js";

export function waitForSessionEvent(
  ws: WebSocket,
  event: string,
  fields: { sessionKey: string; reason?: string },
  timeoutMs?: number,
) {
  const payload = expect.objectContaining(fields);
  return onceMessage(
    ws,
    (message) =>
      message.type === "event" &&
      message.event === event &&
      payload.asymmetricMatch(message.payload),
    timeoutMs,
  );
}
