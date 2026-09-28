import type { LiveTextProjectionText } from "./live-text-continuity.js";
import type { GatewayClient } from "./server-methods/client-types.js";

type GatewayBroadcastStateVersion = {
  presence?: number;
  health?: number;
};

/** Options for gateway websocket broadcasts. */
export type GatewayBroadcastOpts = {
  /** Agent scope for agent-relative keys such as `global`. */
  agentId?: string;
  dropIfSlow?: boolean;
  /** Canonical subscription keys for session-scoped delivery. */
  sessionKeys?: readonly string[];
  /** Target recipients were selected from subscriptions at ingress. */
  sessionSubscriptionVerified?: boolean;
  /** Question owner authorizes ordinary own-run recipients without a broad question grant. */
  questionRecipient?: (client: GatewayClient) => boolean;
  stateVersion?: GatewayBroadcastStateVersion;
  /** Private live-text ownership; omitting coalesce flushes this group's progress. */
  liveText?: {
    group: AbortSignal;
    /** Source continuity changes without revoking already queued publications. */
    sourceEpoch?: object;
    /** Accepted terminal barrier; drain current queued text before retiring its group. */
    settle?: true;
    isCurrent?: () => boolean;
    coalesce?: { key: string; merge: (previous: unknown, next: unknown) => unknown };
    /** Full internal payloads become append-only only after this socket has a baseline. */
    projection?: {
      key: string;
      delta: (payload: unknown) => unknown;
      /** Upper bound for encoded full payload bytes, without encoding cumulative text. */
      snapshotBytes?: (payload: unknown, deltaPayloadBytes: number) => number;
      version?: unknown;
      snapshot?: boolean;
      /** Verify transformed snapshots against the prior publication before omitting them. */
      text?: LiveTextProjectionText;
    };
  };
};

/** Broadcast function signature for all connected clients. */
export type GatewayBroadcastFn = (
  event: string,
  payload: unknown,
  opts?: GatewayBroadcastOpts,
) => void;

/** Broadcast function signature for targeted connection ids. */
export type GatewayBroadcastToConnIdsFn = (
  event: string,
  payload: unknown,
  connIds: ReadonlySet<string>,
  opts?: GatewayBroadcastOpts,
) => void;

/** Current queued outbound bytes for one live gateway connection. */
export type GatewayBufferedAmountFn = (connId: string) => number | undefined;

export type GatewayPluginEventScope = "operator.read" | "operator.write" | "operator.admin";

/** Broadcasts a namespaced plugin event under an explicit operator scope. */
export type GatewayPluginEventBroadcastFn = (
  event: string,
  payload: unknown,
  scope: GatewayPluginEventScope,
) => void;
