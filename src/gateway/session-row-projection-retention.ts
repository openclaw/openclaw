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

/** Sample the owner's actual inventory on memory heartbeats, never on row writes or scrapes. */
export function observeSessionRowProjectionRetention(rows: ReadonlyMap<string, Row>) {
  projections++;
  let previousEntries = 0;
  let previousBytes = 0;
  let previousTruncated = 0;
  let active = true;
  const stop = onInternalDiagnosticEvent(
    (_event, metadata) => {
      if (
        !isInternalDiagnosticEventMetadata(metadata) ||
        !hasInternalDiagnosticEventInterest("sessions.projection.retention", true)
      ) {
        return;
      }
      // The estimator has a fixed visit/depth budget and never invokes row getters/closures.
      const size = estimateRetainedDataSize([rows]);
      entries += rows.size - previousEntries;
      estimatedBytes += size.approximateBytes - previousBytes;
      truncatedProjections += Number(size.truncated) - previousTruncated;
      previousEntries = rows.size;
      previousBytes = size.approximateBytes;
      previousTruncated = Number(size.truncated);
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
