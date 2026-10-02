import type { GatewayClientCap } from "../../packages/gateway-protocol/src/client-info.js";
import type { LiveTextProjectionText } from "./live-text-continuity.js";
import type { GatewayClient } from "./server-methods/client-types.js";
import type { SessionAncestorReferences } from "./session-ancestor-references.js";

export type SessionEventProjection = {
  payload: unknown;
  /** Certifies a fresh, mutable payload envelope and row bytes for this publication. */
  serializeSession?: () => string;
  delivered?: () => void;
};

type SessionEventProjectionScope = {
  sessionKeys: readonly string[];
  agentId?: string;
};

/** Connection-owned receipts and live run state, consumed within one publication. */
type SessionEventProjectionContext = {
  isCurrentProjection: (owner: object) => boolean;
  resolveAgentScope: (
    key: string,
    agentId?: string,
  ) => readonly [string | undefined, string | undefined, string | undefined] | null;
  forgetAncestors: (key?: string) => void;
  references: (client: GatewayClient) => SessionAncestorReferences;
  forgetConnectionAncestors: (client: GatewayClient) => void;
  getRunProjector: () => (selection: {
    requestedKey: string;
    canonicalKey: string;
    sessionId?: string;
    agentId?: string;
    defaultAgentId?: string;
  }) => { active: boolean; runIds?: string[]; status?: "queued" };
};

export type PrepareSessionEventProjection = (
  event: string,
  payload: unknown,
  scope: SessionEventProjectionScope,
  context: SessionEventProjectionContext,
) => ((client: GatewayClient) => SessionEventProjection | undefined) | undefined;

type GatewayBroadcastStateVersion = {
  presence?: number;
  health?: number;
};

/** Options for gateway websocket broadcasts. */
export type GatewayBroadcastOpts = {
  /** Agent scope for agent-relative keys such as `global`. */
  agentId?: string;
  dropIfSlow?: boolean;
  /** Omit a redundant projection for clients that advertise this capability. */
  excludeClientCapability?: GatewayClientCap;
  /** Canonical subscription keys for session-scoped delivery. */
  sessionKeys?: readonly string[];
  /** Prepared facts remain valid only during this synchronous publication. */
  prepareSessionProjection?: PrepareSessionEventProjection;
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
