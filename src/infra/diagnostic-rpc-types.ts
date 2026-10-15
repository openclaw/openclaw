import type { GatewayClientId } from "../../packages/gateway-protocol/src/client-info.js";

/** Payload-free facts from authenticated Gateway WebSocket request owners. */
export type DiagnosticGatewayRpcFields = {
  type: "gateway.rpc";
  /** Registered method name, or a fixed other/unknown bucket. */
  method: string;
} & (
  | {
      phase: "received";
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
