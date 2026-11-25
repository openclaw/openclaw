import { vi } from "vitest";
import { WebSocket } from "ws";
import type { GatewayWsClient } from "./server/ws-types.js";

type RecordingSocket = {
  readyState: number;
  bufferedAmount: number;
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  events: string[];
};

export function makeClient(
  connId: string,
  role: "node" | "operator",
  scopes: string[],
): { client: GatewayWsClient; socket: RecordingSocket } {
  const events: string[] = [];
  const socket: RecordingSocket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    close: vi.fn(),
    send: vi.fn((payload: string) => {
      events.push((JSON.parse(payload) as { event: string }).event);
    }),
    events,
  };
  return {
    client: {
      socket: socket as unknown as GatewayWsClient["socket"],
      connect: { role, scopes } as GatewayWsClient["connect"],
      connId,
      usesSharedGatewayAuth: false,
    },
    socket,
  };
}
