import type { IncomingMessage } from "node:http";
import type { Result } from "@openclaw/normalization-core/result";
import type { GatewayAttributedIngress } from "../ingress-attribution.js";
import type { GatewayRole } from "../role-policy.types.js";

export type GatewayConnectionFrame = Buffer | ArrayBuffer | Buffer[];

export type GatewayConnectionDelivery = {
  /** Only the handshake owner can retain a rejection after transport retirement. */
  rejectedHandshake?: true;
  isCurrent?: () => boolean;
};

export type GatewayConnectionIngress = {
  request: IncomingMessage;
  attribution: GatewayAttributedIngress;
  isCurrent: () => boolean;
};

/** Ordered frames and transport retirement, independent of the physical connection. */
export type GatewayConnectionTransport = {
  /** Uses the WebSocket ready-state values; 1 means open. */
  readonly readyState: number;
  readonly bufferedAmount: number;
  /**
   * Accept JSON text frames in order, including byte-backed text. The optional callback settles after transport
   * delivery or with an error; it is not a peer acknowledgement.
   */
  send(frame: string, callback?: (error?: Error) => void): void;
  send(frame: Buffer, options: { binary: false }, callback?: (error?: Error) => void): void;
  sendWithContext?: (
    frame: string | Buffer,
    callback: ((error?: Error) => void) | undefined,
    delivery: GatewayConnectionDelivery | undefined,
  ) => void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: "message", listener: (data: GatewayConnectionFrame) => void): unknown;
  off(event: "message", listener: (data: GatewayConnectionFrame) => void): unknown;
  off(event: "close", listener: (code: number, reason: Buffer) => void): unknown;
  once(event: "message", listener: (data: GatewayConnectionFrame) => void): unknown;
  once(event: "close", listener: (code: number, reason: Buffer) => void): unknown;
};

export function sendGatewayConnectionFrame(
  socket: GatewayConnectionTransport,
  frame: string | Buffer,
  callback?: (error?: Error) => void,
  delivery?: GatewayConnectionDelivery,
): void {
  if (socket.sendWithContext) {
    socket.sendWithContext(frame, callback, delivery);
  } else if (typeof frame === "string") {
    socket.send(frame, callback);
  } else {
    socket.send(frame, { binary: false }, callback);
  }
}

/** Validate receive limits before registration; activate them only after registration. */
export type PrepareGatewayAuthenticatedReceive = (
  role: GatewayRole,
) => Result<() => void, { cause: string; message: string }>;
