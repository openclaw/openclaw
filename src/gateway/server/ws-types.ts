import type { WebSocket } from "ws";
import type { ConnectParams } from "../protocol/index.js";

export type GatewayConnectionHealthState = {
  connectedAtMs: number;
  lastPingSentAtMs?: number;
  pendingPingSentAtMs?: number[];
  lastHeartbeatAtMs?: number;
  rttMs?: number;
};

export type GatewayWsClient = {
  socket: WebSocket;
  connect: ConnectParams;
  connId: string;
  connectionHealth: GatewayConnectionHealthState;
  isDeviceTokenAuth?: boolean;
  usesSharedGatewayAuth: boolean;
  sharedGatewaySessionGeneration?: string;
  presenceKey?: string;
  clientIp?: string;
  canvasHostUrl?: string;
  canvasCapability?: string;
  canvasCapabilityExpiresAtMs?: number;
};
