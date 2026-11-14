import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import type { WebSocket } from "ws";
import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";

export function collectSessionRowFrames(ws: WebSocket, rawFrames?: string[]): EventFrame[] {
  const frames: EventFrame[] = [];
  ws.on("message", (data) => {
    const raw = rawDataToString(data);
    const frame = JSON.parse(raw) as EventFrame;
    if (frame.type === "event" && ["sessions.changed", "session.message"].includes(frame.event)) {
      frames.push(frame);
      rawFrames?.push(raw);
    }
  });
  return frames;
}

export async function closeSessionRowSocket(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolve) => {
    ws.once("close", () => resolve());
    ws.close();
  });
}
