import { EventEmitter } from "node:events";
import { vi } from "vitest";
import { WebSocket } from "ws";
import type { GatewayBroadcastOpts } from "./server-broadcast-types.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";

type BroadcastFrame<Payload = unknown> = {
  type: "event";
  event: string;
  seq: number;
  payload: Payload;
  recipientProfileId?: string;
};
export const eventFrame = (
  event: string,
  payload: unknown,
  seq = 1,
  extra: { recipientProfileId?: string; stateVersion?: GatewayBroadcastOpts["stateVersion"] } = {},
) => ({ type: "event", event, payload, seq, ...extra });
type Send = (
  wire: string | Buffer,
  options?: { binary: false } | ((error?: Error) => void),
  callback?: (error?: Error) => void,
) => void;

export function createBroadcastPeer<Payload = unknown>(
  connId: string,
  completeImmediately = false,
  connect: Partial<GatewayWsClient["connect"]> = {},
) {
  const callbacks: Array<(error?: Error) => void> = [];
  const frames: BroadcastFrame<Payload>[] = [];
  const socket = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    close: vi.fn(),
    terminate: vi.fn(),
    send: vi.fn<Send>((wire, options, callback) => {
      frames.push(JSON.parse(String(wire)));
      const done = typeof options === "function" ? options : callback;
      if (completeImmediately) {
        done?.();
      } else if (done) {
        callbacks.push(done);
      }
    }),
  });
  const client: GatewayWsClient = {
    connId,
    socket: socket as unknown as GatewayWsClient["socket"],
    connect: {
      role: "operator",
      scopes: ["operator.read"],
      ...connect,
    } as GatewayWsClient["connect"],
    usesSharedGatewayAuth: false,
  };
  return {
    client,
    socket,
    frames,
    callbacks,
    complete: (error?: Error) => callbacks.shift()?.(error),
  };
}

export function broadcastFor(
  peers: readonly { client: GatewayWsClient }[],
  options: Omit<Parameters<typeof createGatewayBroadcaster>[0], "clients"> = {},
) {
  const clients = new GatewayClientRegistry(peers.map(({ client }) => client));
  return { clients, ...createGatewayBroadcaster({ ...options, clients }) };
}

const replaceText = (_previous: unknown, next: unknown) => next;
export const coalesced = (group: AbortSignal, key = "text", merge = replaceText) => ({
  liveText: { group, coalesce: { key, merge } },
});
