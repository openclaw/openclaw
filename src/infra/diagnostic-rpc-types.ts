/** Payload-free facts from authenticated Gateway WebSocket request owners. */
export type DiagnosticGatewayRpcFields = {
  type: "gateway.rpc";
  /** Registered method name, or a fixed other/unknown bucket. */
  method: string;
} & (
  | { phase: "received" }
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
    }
  | {
      phase: "dispatch";
      outcome: "returned" | "threw" | "rejected" | "cancelled";
      durationMs: number;
      queueWaitMs?: number;
      response: "none" | "sent" | "unavailable" | "suppressed";
      /** Main-thread heap change over the request; GC can make this negative. */
      heapDeltaBytes?: number;
    }
);
