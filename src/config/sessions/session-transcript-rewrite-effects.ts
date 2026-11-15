import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isUserMessage,
  projectRecordedModelPrompt,
} from "../../sessions/user-turn-transcript.message.js";
import { normalizePersistedSteerTargetRunId } from "../../sessions/user-turn-transcript.metadata.js";
import {
  extractTranscriptIndexEntry,
  hasTranscriptMessage,
  transcriptEventContextEligibility,
} from "./session-transcript-projection-append.js";

export function transcriptRewritePreservesAdmission(
  beforeJson: string,
  afterJson: string,
): boolean {
  const before: unknown = JSON.parse(beforeJson);
  const after: unknown = JSON.parse(afterJson);
  const beforeMetadata =
    isRecord(before) && isUserMessage(before.message) ? before.message["__openclaw"] : undefined;
  const previousSteerTarget = beforeMetadata?.steerTargetRunId;
  const previousProjection = beforeMetadata?.modelPromptProjection;
  for (const event of [before, after]) {
    if (!isRecord(event) || event.type !== "message" || !isUserMessage(event.message)) {
      return false;
    }
    const metadata = event.message["__openclaw"];
    if (metadata !== undefined && !isRecord(metadata)) {
      return false;
    }
    if (
      event === after &&
      (previousSteerTarget !== undefined || metadata?.steerTargetRunId !== undefined)
    ) {
      const target = normalizePersistedSteerTargetRunId(metadata?.steerTargetRunId);
      if (!target || target !== metadata?.steerTargetRunId) {
        return false;
      }
    }
    if (metadata) {
      delete metadata.steerTargetRunId;
      // Recording already-identical replay text must not revoke earlier completed turns.
      if (event === after && previousProjection === undefined && metadata.modelPromptProjection) {
        const projection = metadata.modelPromptProjection;
        if (
          !isRecord(projection) ||
          projection.version !== 1 ||
          typeof projection.text !== "string"
        ) {
          return false;
        }
        const projected = projectRecordedModelPrompt(event.message);
        if (!isDeepStrictEqual(projected.content, event.message.content)) {
          return false;
        }
        delete metadata.modelPromptProjection;
      }
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
