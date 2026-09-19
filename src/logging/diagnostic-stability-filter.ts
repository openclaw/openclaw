import type { InternalDiagnosticEventInterest } from "../infra/diagnostic-event-listener-presence.js";
import type { DiagnosticEventPayload } from "../infra/diagnostic-events.js";

/** Support bundles exclude exporter-only traffic and private owner/admission observations. */
export const DIAGNOSTIC_STABILITY_EVENT_INTEREST = {
  exclude: [
    "log.record",
    "telemetry.exporter",
    "gateway.rpc",
    "gateway.admission",
    "gateway.run.owner",
    "gateway.event_loop.sample",
    "diagnostic.gc",
  ],
} as const satisfies InternalDiagnosticEventInterest<DiagnosticEventPayload["type"]>;
