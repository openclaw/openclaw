import type { DiagnosticTraceContext } from "./diagnostic-trace-context.js";

type DiagnosticBaseEvent = {
  ts: number;
  seq: number;
  trace?: DiagnosticTraceContext;
};

/** Payload-free facts from authenticated Gateway WebSocket request owners. */
export type DiagnosticGatewayRpcEvent = DiagnosticBaseEvent & {
  type: "gateway.rpc";
  /** Canonical core method name, or a fixed other/unknown bucket. */
  method: string;
} & (
    | { phase: "received" }
    | {
        phase: "response";
        outcome: "ok" | "error" | "unavailable" | "suppressed";
        durationMs: number;
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
      }
  );

/** Prepared runtime guard facts only; validation does not prove a later session write. */
export type DiagnosticModelRuntimeChoiceEvent = DiagnosticBaseEvent & {
  type: "model.runtime_choice";
  version: 1;
  checks: {
    ownerLookup: "not-reached" | "present" | "absent";
    authStore: "not-reached" | "present" | "absent";
    catalogPresence: "not-reached" | "present" | "absent";
    offCatalogAuth: "not-reached" | "available" | "unavailable";
    offCatalogAuthMode: "not-reached" | "available" | "unavailable";
    offCatalogResolution: "not-reached" | "resolved" | "unresolved";
    runtimeEligibility: "not-reached" | "eligible" | "ineligible";
    commitOwnerFreshness: "not-reached" | "current" | "stale";
    nativeAvailability: "not-reached" | "available" | "unavailable";
  };
} & (
    | { phase: "prepare"; outcome: "ready"; reason: "ready" }
    | {
        phase: "prepare";
        outcome: "unavailable";
        reason:
          | "owner-missing"
          | "auth-store-missing"
          | "off-catalog-auth-unavailable"
          | "off-catalog-auth-mode-unavailable"
          | "off-catalog-resolution-unavailable"
          | "runtime-ineligible";
      }
    | { phase: "validate"; outcome: "ready"; reason: "ready" }
    | {
        phase: "validate";
        outcome: "unavailable";
        reason: "owner-stale" | "native-unavailable";
      }
  );
