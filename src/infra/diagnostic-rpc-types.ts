import type { GatewayClientId } from "../../packages/gateway-protocol/src/client-info.js";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/schema/sessions-list.js";

/** Process totals for retained session-list views and their estimated memory. */
type DiagnosticSessionsListRetentionFields = {
  type: "sessions.list.retention";
  views: number;
  refs: number;
  estimatedBytes: number;
};

/** Process totals for per-connection session-event field-hash vectors. */
type DiagnosticSessionEventRetentionFields = {
  type: "sessions.event.retention";
  entries: number;
  estimatedBytes: number;
};

export type SessionEventRowsResetCause =
  | "close"
  | "delivery-lost"
  | "generation"
  | "evicted"
  | "projection";

/** Number of retained wire baselines retired by one bounded lifecycle cause. */
type DiagnosticSessionEventRowsResetFields = {
  type: "sessions.event.rows.reset";
  cause: SessionEventRowsResetCause;
  count: number;
};

export type SessionsListBaseMissReason = "unknown-base" | "all-rows-changed";

type DiagnosticSessionsListBaselineRetiredFields = {
  type: "sessions.list.baseline.retired";
  cause:
    | "projection-revision"
    | "config"
    | "identity"
    | "selection-reset"
    | "view-evicted"
    | "history-evicted";
};

type SessionsListAttribution = {
  clientKind: GatewayClientId;
  source: "wire" | "internal";
  callerSource: NonNullable<SessionsListParams["source"]> | "unspecified";
  rowMode: NonNullable<SessionsListParams["rowMode"]> | "full" | "other";
  filter: "search" | "children" | "owner" | "involving" | "active" | "general";
};

/** Payload-free facts from authenticated Gateway WebSocket request owners. */
type DiagnosticGatewayRpcFields = {
  type: "gateway.rpc";
  /** Registered method name, or a fixed other/unknown bucket. */
  method: string;
} & (
  | {
      phase: "received";
      /** Coarse handshake identity; never a device id, platform, or display name. */
      clientKind?: "control-ui" | "macos" | "ios" | "android" | "cli" | "node" | "plugin" | "other";
      cronList?: {
        clientKind: GatewayClientId;
        source: "wire" | "internal";
        scope: "global" | "agent" | "session";
        compact: boolean;
        page: "first" | "append";
      };
      sessionsList?: SessionsListAttribution;
      modelsList?: {
        clientKind: GatewayClientId;
        source: "wire" | "internal";
        view: "default" | "configured" | "provider-config" | "all" | "other";
        scope: "global" | "agent" | "session" | "auth-profile";
        refresh: boolean;
        preparedOnly: boolean;
      };
    }
  | {
      phase: "response";
      outcome: "ok" | "error" | "unavailable" | "suppressed";
      durationMs: number;
      /** Later sent frames carry bytes without repeating first-response timings. */
      firstResponse?: boolean;
      responseBytes?: number;
      sessionsList?: SessionsListAttribution & {
        rowsOutcome: "unchanged" | "delta" | "full-no-base" | "full-with-base" | "not-sidebar";
        baseMissReason?: SessionsListBaseMissReason;
      };
      chatHistory?: {
        clientKind: GatewayClientId;
        source: "wire" | "internal";
        shape: "cursor" | "older" | "pending" | "receipt" | "anchor" | "tail";
        limitBucket: "<=20" | "<=80" | "<=200" | ">200";
        outcome: "delta" | "reset" | "page";
      };
    }
  | {
      phase: "handler";
      outcome: "returned" | "threw";
      durationMs: number;
      admissionMs: number;
      /** Exclusive main-thread handler window; background work and GC can still affect it. */
      heapDeltaBytes?: number;
    }
  | {
      phase: "dispatch";
      outcome: "returned" | "threw" | "rejected" | "cancelled";
      durationMs: number;
      queueWaitMs?: number;
      response: "none" | "sent" | "unavailable" | "suppressed";
    }
);

export type GatewayWsPresenceMode = "delta" | "reset" | "legacy";

export type GatewayWsSessionEventAttribution = {
  reason: string;
  delivery: "subscribed" | "roster";
};

/** Payload-free observations from the physical WebSocket transport. */
type DiagnosticGatewayWsFields =
  | {
      type: "gateway.ws.event";
      event: string;
      count: number;
      bytes: number;
      /** Post-codec payload bytes; excludes WebSocket and lower-level headers. */
      wireBytes?: number;
      /** Cumulative raw frame counts by fixed upper byte bound, including +Inf. */
      frameBytes?: Record<string, number>;
      sessionEvent?: GatewayWsSessionEventAttribution;
      presenceMode?: GatewayWsPresenceMode;
    }
  | { type: "gateway.ws.connections"; operators: number };

export type DiagnosticGatewayFields =
  | DiagnosticGatewayRpcFields
  | DiagnosticGatewayWsFields
  | DiagnosticSessionsListBaselineRetiredFields
  | DiagnosticSessionsListRetentionFields
  | DiagnosticSessionEventRetentionFields
  | DiagnosticSessionEventRowsResetFields;
