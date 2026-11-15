import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  readSessionActorCompleteTranscriptFromReplica,
  readSessionActorTranscriptStateFromReplica,
} from "./session-actor-replica.js";
import { readSessionTranscriptAccountingTail } from "./session-transcript-accounting-policy.js";
import {
  SQLITE_USAGE_TAIL_MAX_EVENTS,
  type SessionTranscriptAccountingOptions,
  type SessionTranscriptAccountingSnapshot,
} from "./session-transcript-accounting.types.js";

/** Complete resident context advances with the actor's committed transcript receipts. */
export function readSessionTranscriptAccountingFromReplica(
  target: { path: string; sessionKey: string; sessionId: string },
  options: SessionTranscriptAccountingOptions,
): SessionTranscriptAccountingSnapshot | undefined {
  if (!options.includeUsage && !options.includeTurnTaint) {
    if (!options.includeByteSize) {
      return {};
    }
    const stats = readSessionActorTranscriptStateFromReplica(target)?.transcript.contextStats;
    return stats ? { byteSize: stats.sizeBytes, eventCount: stats.eventCount } : undefined;
  }
  const current = readSessionActorCompleteTranscriptFromReplica(target);
  if (!current) {
    return undefined;
  }
  const stats = current.snapshot.transcript.contextStats;
  if (options.includeByteSize && !stats) {
    return undefined;
  }
  const result: SessionTranscriptAccountingSnapshot = {};
  if (options.includeByteSize && stats) {
    result.byteSize = stats.sizeBytes;
    result.eventCount = stats.eventCount;
  }
  Object.assign(
    result,
    readSessionTranscriptAccountingTail((visit) => {
      let visited = 0;
      for (
        let index = current.rows.length - 1;
        index >= 0 && visited < SQLITE_USAGE_TAIL_MAX_EVENTS;
        index -= 1
      ) {
        const { event } = current.rows[index]!;
        if (isRecord(event) && event.type === "session") {
          continue;
        }
        visit(event);
        visited += 1;
      }
    }, options),
  );
  // The policy borrows trailing message bodies; callers own the returned snapshot.
  return structuredClone(result);
}
