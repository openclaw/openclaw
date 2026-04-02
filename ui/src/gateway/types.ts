export interface RPCRequest {
  type: "req";
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface RPCResponse {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string };
}

export interface RPCEvent {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
}

export type RPCFrame = RPCRequest | RPCResponse | RPCEvent;

export interface ConnectOptions {
  gatewayUrl: string;
  token?: string;
  password?: string;
  deviceIdentity: DeviceIdentity;
}

export interface DeviceIdentity {
  id: string;
  publicKey: string;
  sign: (data: Uint8Array) => Promise<Uint8Array>;
}

export interface ControlUIConfig {
  basePath: string;
  assistantName?: string;
  assistantAvatar?: string;
}

export interface HealthSummary {
  ok: boolean;
  agents: number;
  sessions: { count: number; recent: number };
  uptime: number;
}

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "connected"
  | "error";
