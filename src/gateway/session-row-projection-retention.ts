import { hasInternalDiagnosticEventInterest } from "../infra/diagnostic-event-listener-presence.js";
import {
  emitTrustedDiagnosticEvent,
  isInternalDiagnosticEventMetadata,
  onInternalDiagnosticEvent,
} from "../infra/diagnostic-events.js";
import { estimateRetainedDataSize } from "../infra/retained-data-size.js";
import type { Row } from "./session-row-projection-record.js";

let projections = 0;
let entries = 0;
let estimatedBytes = 0;
let truncatedProjections = 0;

function report() {
  emitTrustedDiagnosticEvent({
    type: "sessions.projection.retention",
    projections,
    entries,
    estimatedBytes,
    truncatedProjections,
  });
}

/** Count inventory on memory heartbeats; bound graph walks to once every five minutes. */
export function observeSessionRowProjectionRetention(rows: ReadonlyMap<string, Row>) {
  projections++;
  let previousEntries = 0;
  let previousBytes = 0;
  let previousTruncated = 0;
  let nextEstimateAt = 0;
  let active = true;
  const stop = onInternalDiagnosticEvent(
    (_event, metadata) => {
      if (
        !isInternalDiagnosticEventMetadata(metadata) ||
        !hasInternalDiagnosticEventInterest("sessions.projection.retention", true)
      ) {
        return;
      }
      const now = performance.now();
      if (now >= nextEstimateAt) {
        // Byte estimates are sampled; exact row counts remain current on every heartbeat.
        const size = estimateRetainedDataSize([rows]);
        estimatedBytes += size.approximateBytes - previousBytes;
        truncatedProjections += Number(size.truncated) - previousTruncated;
        previousBytes = size.approximateBytes;
        previousTruncated = Number(size.truncated);
        nextEstimateAt = now + 5 * 60_000;
      }
      entries += rows.size - previousEntries;
      previousEntries = rows.size;
      report();
    },
    { include: ["diagnostic.memory.sample"] },
  );
  return () => {
    if (!active) {
      return;
    }
    active = false;
    stop();
    projections--;
    entries -= previousEntries;
    estimatedBytes -= previousBytes;
    truncatedProjections -= previousTruncated;
    report();
  };
}
