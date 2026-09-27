import type { Result } from "@openclaw/normalization-core/result";
import type { GatewayRole } from "../role-policy.types.js";

export type GatewayConnectionFrame = Buffer | ArrayBuffer | Buffer[];

/** Ordered frames and transport retirement, independent of the physical connection. */
export type GatewayConnectionTransport = {
  /** Uses the WebSocket ready-state values; 1 means open. */
  readonly readyState: number;
  readonly bufferedAmount: number;
  /**
   * Accept frames in order. The optional callback settles after transport
   * delivery or with an error; it is not a peer acknowledgement.
   */
  send(frame: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: "message", listener: (data: GatewayConnectionFrame) => void): unknown;
  off(event: "message", listener: (data: GatewayConnectionFrame) => void): unknown;
  off(event: "close", listener: (code: number, reason: Buffer) => void): unknown;
  once(event: "message", listener: (data: GatewayConnectionFrame) => void): unknown;
  once(event: "close", listener: (code: number, reason: Buffer) => void): unknown;
};

/** Validate receive limits before registration; activate them only after registration. */
export type PrepareGatewayAuthenticatedReceive = (
  role: GatewayRole,
) => Result<() => void, { cause: string; message: string }>;
