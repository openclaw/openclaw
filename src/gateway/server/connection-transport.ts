import type { Result } from "@openclaw/normalization-core/result";
import type {
  GatewayWsPresenceMode,
  GatewayWsSessionEventAttribution,
} from "../../infra/diagnostic-rpc-types.js";
import type { GatewayRole } from "../role-policy.types.js";

export type GatewayConnectionFrame = Buffer | ArrayBuffer | Buffer[];

/** Ordered frames and transport retirement, independent of the physical connection. */
export type GatewayConnectionTransport = {
  /** Uses the WebSocket ready-state values; 1 means open. */
  readonly readyState: number;
  readonly bufferedAmount: number;
  /** Installed codec can reuse worker-produced raw deflate with the default 15-bit window. */
  readonly acceptsDeflatedSegments?: boolean;
  /** Physical WebSockets record accepted event frames and their encoded payload size. */
  recordEventSent?(
    event: string,
    frame: Buffer,
    sessionEvent?: GatewayWsSessionEventAttribution,
    presenceMode?: GatewayWsPresenceMode,
  ): void;
  /** Combine writes until the next tick without changing frame order or callbacks. */
  batchWrites?(): void;
  /** Send a secret-bearing frame outside negotiated compression; transports that compress must provide it. */
  sendUncompressed?(frame: string, callback?: (error?: Error) => void): void;
  /**
   * Accept JSON text frames in order, including byte-backed text. The optional callback settles after transport
   * delivery or with an error; it is not a peer acknowledgement.
   */
  send(frame: string, callback?: (error?: Error) => void): void;
  send(frame: Buffer, options: { binary: false }, callback?: (error?: Error) => void): void;
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
