import type { DiagnosticEventPayload } from "../infra/diagnostic-events.js";
import { normalizeDiagnosticRunInterruption } from "../infra/diagnostic-run-types.js";
import type { DiagnosticStabilityEventRecord } from "./diagnostic-stability-types.js";

/** Retains bounded run facts at the diagnostic stability export boundary. */
export function projectDiagnosticRunEvent(
  event: Extract<DiagnosticEventPayload, { type: "run.started" | "run.completed" }>,
  copyReasonCode: (value: unknown) => string | undefined,
): Pick<
  DiagnosticStabilityEventRecord,
  | "provider"
  | "model"
  | "channel"
  | "durationMs"
  | "outcome"
  | "reason"
  | "abortCause"
  | "timeoutPhase"
  | "timeoutSource"
> {
  const record: ReturnType<typeof projectDiagnosticRunEvent> = {
    provider: event.provider,
    model: event.model,
    channel: event.channel,
  };
  if (event.type === "run.started") {
    return record;
  }
  record.durationMs = event.durationMs;
  record.outcome = event.outcome;
  const reason = copyReasonCode(event.errorCategory);
  if (reason) {
    record.reason = reason;
  }
  Object.assign(record, normalizeDiagnosticRunInterruption(event));
  return record;
}
