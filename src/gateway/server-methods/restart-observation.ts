import { hasInternalDiagnosticEventInterest } from "../../infra/diagnostic-event-listener-presence.js";
import {
  areDiagnosticsEnabledForProcess,
  emitTrustedDiagnosticEvent,
} from "../../infra/diagnostic-events.js";
import { markCoreGatewayAdmissionEvent } from "../../infra/diagnostic-gateway-admission-provenance.js";
import {
  getActiveDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
  parseDiagnosticTraceparent,
} from "../../infra/diagnostic-trace-context.js";

/** Capture the existing authenticated request span; report only the signal owner result. */
export function captureGatewayRestartAdmissionObservation(
  traceparent: string | undefined,
): ((outcome: "emitted" | "coalesced" | "failed") => void) | undefined {
  try {
    if (
      !areDiagnosticsEnabledForProcess() ||
      !hasInternalDiagnosticEventInterest("gateway.admission")
    ) {
      return undefined;
    }
    const upstream = parseDiagnosticTraceparent(traceparent);
    const activeTrace = getActiveDiagnosticTraceContext();
    if (
      !upstream?.spanId ||
      !activeTrace?.spanId ||
      activeTrace.traceId !== upstream.traceId ||
      activeTrace.parentSpanId !== upstream.spanId
    ) {
      return undefined;
    }
    const trace = freezeDiagnosticTraceContext(activeTrace);
    return (outcome) => {
      try {
        emitTrustedDiagnosticEvent(
          markCoreGatewayAdmissionEvent({
            type: "gateway.admission",
            method: "gateway.restart.request",
            outcome,
            trace,
          }),
        );
      } catch {
        // Diagnostic loss must not change restart admission, delivery, or its response.
      }
    };
  } catch {
    return undefined;
  }
}
