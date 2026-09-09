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
   * Accept frames in order. A callback settles exactly once after the frame is
   * written, or with an error on failed delivery, including close while queued.
   * Enqueueing alone must not report success; completion is not a peer ACK.
   */
  send(frame: string, callback?: (error?: Error) => void): void;
  sendWithContext?: (
    frame: string,
    callback: ((error?: Error) => void) | undefined,
    delivery: GatewayConnectionDelivery | undefined,
  ) => void;
  /** Preserve accepted frame ordering before graceful close; terminate may discard them. */
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
  frame: string,
  callback?: (error?: Error) => void,
  delivery?: GatewayConnectionDelivery,
): void {
  if (socket.sendWithContext) {
    socket.sendWithContext(frame, callback, delivery);
  } else {
    socket.send(frame, callback);
  }
}

/** Validate transport-owned receive limits before registration; activate only after it. */
export type PrepareGatewayAuthenticatedReceive = (
  role: GatewayRole,
) => Result<() => void, { cause: string; message: string }>;
