import { activeDiagnosticOwners } from "../logging/diagnostic-run-activity-state.js";
import {
  emitTrustedDiagnosticEventWithPrivateData,
  type DiagnosticEventInput,
  type DiagnosticEventMetadata,
  type DiagnosticEventPrivateData,
} from "./diagnostic-events.js";
import {
  CORE_MODEL_REQUEST_LIFECYCLE_METADATA_KEY,
  markCoreModelRequestLifecycleDiagnosticEvent,
  type CoreModelRequestLifecycleProvenance,
  type CoreModelRequestOwnerGeneration,
} from "./diagnostic-model-request-provenance.js";

type CoreModelRequestStartedEventInput = Omit<
  Extract<DiagnosticEventInput, { type: "model.call.started" }>,
  "observationUnit" | "type"
>;

type CoreModelRequestStartedMetadata = DiagnosticEventMetadata &
  Readonly<{
    [CORE_MODEL_REQUEST_LIFECYCLE_METADATA_KEY]?: CoreModelRequestLifecycleProvenance;
  }>;

/** Emits a request attempt from the core boundary that owns provider streaming. */
export function emitCoreModelRequestStartedDiagnosticEvent(
  event: CoreModelRequestStartedEventInput,
  generation?: CoreModelRequestOwnerGeneration,
  requestTimeoutMs?: number,
  privateData?: DiagnosticEventPrivateData,
): void {
  // Publish the active request's allowance before optional/asynchronous diagnostics.
  // Retries retain semantic history while their actual request deadlines remain distinct.
  if (generation) {
    activeDiagnosticOwners.get(generation)?.owner.watchdogAttempt?.requestEvent({
      phase: "start",
      callId: event.callId,
      requestTimeoutMs,
    });
  }
  const startedEvent = {
    ...event,
    type: "model.call.started" as const,
    observationUnit: "request" as const,
  };
  emitTrustedDiagnosticEventWithPrivateData(
    generation
      ? markCoreModelRequestLifecycleDiagnosticEvent(startedEvent, {
          generation,
          phase: "started",
          ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
        })
      : startedEvent,
    privateData,
  );
}

type CoreModelRequestEndedEventInput = Extract<
  DiagnosticEventInput,
  { type: "model.call.completed" | "model.call.error" }
>;

/** Emits a terminal owned by the same core model-request generation as its start. */
export function emitCoreModelRequestEndedDiagnosticEvent(
  event: CoreModelRequestEndedEventInput,
  generation?: CoreModelRequestOwnerGeneration,
  privateData?: DiagnosticEventPrivateData,
): void {
  if (generation) {
    activeDiagnosticOwners
      .get(generation)
      ?.owner.watchdogAttempt?.requestEvent({ phase: "end", callId: event.callId });
  }
  emitTrustedDiagnosticEventWithPrivateData(
    generation
      ? markCoreModelRequestLifecycleDiagnosticEvent(event, { generation, phase: "ended" })
      : event,
    privateData,
  );
}

/** Returns exact core lifecycle provenance assigned by the dispatcher. */
export function resolveCoreModelRequestLifecycleDiagnosticMetadata(
  metadata: DiagnosticEventMetadata,
): CoreModelRequestLifecycleProvenance | undefined {
  return (metadata as CoreModelRequestStartedMetadata)[CORE_MODEL_REQUEST_LIFECYCLE_METADATA_KEY];
}
