import type { WebSocket } from "ws";
import type { ConnectParams } from "../protocol/index.js";

export type GatewayWsClient = {
  socket: WebSocket;
  connect: ConnectParams;
  connId: string;
  presenceKey?: string;
  clientIp?: string;
};

export type GatewayWsSendState = {
  queue: PendingWsFrame[];
  flushTimer: NodeJS.Timeout | null;
  dropped: number;
  truncated: number;
  batches: number;
  slowStrikes: number;
  lastLogTs: number;
};

export type PendingWsFrame = {
  json: string;
  event: string;
  size: number;
  messageType?: string;
  droppable: boolean;
  critical: boolean;
  truncated?: boolean;
};
