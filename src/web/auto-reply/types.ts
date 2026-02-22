import type { monitorWebInbox } from "../inbound.js";
import type { ReconnectPolicy, TieredReconnectPolicy } from "../reconnect.js";

export type WebInboundMsg = Parameters<typeof monitorWebInbox>[0]["onMessage"] extends (
  msg: infer M,
) => unknown
  ? M
  : never;

export type WebChannelStatus = {
  running: boolean;
  connected: boolean;
  reconnectAttempts: number;
  lastConnectedAt?: number | null;
  lastDisconnect?: {
    at: number;
    status?: number;
    error?: string;
    loggedOut?: boolean;
  } | null;
  lastMessageAt?: number | null;
  lastEventAt?: number | null;
  lastError?: string | null;
};

export type WebMonitorTuning = {
  /** @deprecated Use tieredReconnect instead for graduated retry strategy. */
  reconnect?: Partial<ReconnectPolicy>;
  /** Three-tier graduated retry strategy for resilient connection handling. */
  tieredReconnect?: Partial<TieredReconnectPolicy>;
  heartbeatSeconds?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  statusSink?: (status: WebChannelStatus) => void;
  /** WhatsApp account id. Default: "default". */
  accountId?: string;
  /** Debounce window (ms) for batching rapid consecutive messages from the same sender. */
  debounceMs?: number;
};
