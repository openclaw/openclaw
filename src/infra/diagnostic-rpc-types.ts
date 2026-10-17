import type { GatewayClientId } from "../../packages/gateway-protocol/src/client-info.js";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/schema/sessions-list.js";

export type SessionsListBaseMissReason = "unknown-base" | "all-rows-changed";

export type DiagnosticSessionsListBaselineRetiredFields = {
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
export type DiagnosticGatewayRpcFields = {
  type: "gateway.rpc";
  /** Registered method name, or a fixed other/unknown bucket. */
  method: string;
} & (
  | {
      phase: "received";
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

export type GatewayWsSessionEventAttribution = {
  reason: string;
  delivery: "subscribed" | "roster";
};

/** Payload-free observations from the physical WebSocket transport. */
export type DiagnosticGatewayWsFields =
  | {
      type: "gateway.ws.event";
      event: string;
      count: number;
      bytes: number;
      sessionEvent?: GatewayWsSessionEventAttribution;
    }
  | { type: "gateway.ws.connections"; operators: number };
