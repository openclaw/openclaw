import { emitTrustedDiagnosticEvent } from "../infra/diagnostic-events.js";
import type { SessionEventRowsResetCause } from "../infra/diagnostic-rpc-types.js";

let entries = 0;
let bytes = 0;
let reportPending = false;
const resets = new Map<SessionEventRowsResetCause, number>();

/** Aggregate vector charges; connection owners account only committed handoffs and releases. */
export function updateSessionEventRowRetention(entriesDelta: number, bytesDelta: number) {
  entries += entriesDelta;
  bytes += bytesDelta;
  scheduleReport();
}

/** Batch only committed retirements, with a fixed set of causes and no row identities. */
export function recordSessionEventRowReset(cause: SessionEventRowsResetCause, count: number) {
  if (count === 0) {
    return;
  }
  resets.set(cause, (resets.get(cause) ?? 0) + count);
  scheduleReport();
}

function scheduleReport() {
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
    for (const [cause, count] of resets) {
      emitTrustedDiagnosticEvent({ type: "sessions.event.rows.reset", cause, count });
    }
    resets.clear();
  }).unref();
}
