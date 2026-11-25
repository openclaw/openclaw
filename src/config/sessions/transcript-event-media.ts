import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { canonicalizePersistedUserMessageMedia } from "../../media/media-facts.js";
import type { TranscriptEvent } from "./session-accessor.types.js";

export function canonicalizeTranscriptEventMedia(event: TranscriptEvent): TranscriptEvent {
  if (!isRecord(event)) {
    return event;
  }
  const message = event.message;
  if (event.type !== "message" || !isRecord(message)) {
    return event;
  }
  const canonical = canonicalizePersistedUserMessageMedia(message);
  return canonical.changed ? { ...event, message: canonical.message } : event;
}
