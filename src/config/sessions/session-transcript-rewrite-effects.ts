import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizePersistedSteerTargetRunId } from "../../sessions/user-turn-transcript.metadata.js";
import {
  extractTranscriptIndexEntry,
  hasTranscriptMessage,
  transcriptEventContextEligibility,
} from "./session-transcript-projection-append.js";

export function isSteerConfirmationRewrite(beforeJson: string, afterJson: string): boolean {
  const before: unknown = JSON.parse(beforeJson);
  const after: unknown = JSON.parse(afterJson);
  for (const event of [before, after]) {
    if (
      !isRecord(event) ||
      event.type !== "message" ||
      !isRecord(event.message) ||
      event.message.role !== "user"
    ) {
      return false;
    }
    const metadata = event.message["__openclaw"];
    if (metadata !== undefined && !isRecord(metadata)) {
      return false;
    }
    if (event === after) {
      const target = normalizePersistedSteerTargetRunId(metadata?.steerTargetRunId);
      if (!target || target !== metadata?.steerTargetRunId) {
        return false;
      }
    }
    if (metadata) {
      delete metadata.steerTargetRunId;
      if (Object.keys(metadata).length === 0) {
        delete event.message["__openclaw"];
      }
    }
  }
  return isDeepStrictEqual(before, after);
}

export function transcriptRewritePreservesProjection(
  beforeJson: string,
  afterJson: string,
): boolean {
  const before: unknown = JSON.parse(beforeJson);
  const after: unknown = JSON.parse(afterJson);
  if (!isRecord(before) || !isRecord(after)) {
    return false;
  }
  const { message: _beforeMessage, ...beforeEnvelope } = before;
  const { message: _afterMessage, ...afterEnvelope } = after;
  // Equal envelopes preserve tree topology and timestamp; exact rewrites retain created_at,
  // so the index extractor's fallback timestamp is identical for both versions as well.
  return (
    isDeepStrictEqual(beforeEnvelope, afterEnvelope) &&
    hasTranscriptMessage(before) === hasTranscriptMessage(after) &&
    transcriptEventContextEligibility(before) === transcriptEventContextEligibility(after) &&
    isDeepStrictEqual(extractTranscriptIndexEntry(before, 0), extractTranscriptIndexEntry(after, 0))
  );
}
