import { emitTrustedDiagnosticEvent } from "../infra/diagnostic-events.js";

let entries = 0;
let bytes = 0;
let reportPending = false;

/** Aggregate vector charges; connection owners account only committed handoffs and releases. */
export function updateSessionEventRowRetention(entriesDelta: number, bytesDelta: number) {
  entries += entriesDelta;
  bytes += bytesDelta;
  if (reportPending) {
    return;
  }
  reportPending = true;
  setImmediate(() => {
    reportPending = false;
    emitTrustedDiagnosticEvent({
      type: "sessions.event.retention",
      entries,
      estimatedBytes: bytes,
    });
  }).unref();
}

export function readSessionEventRowRetention() {
  return { entries, bytes };
}
