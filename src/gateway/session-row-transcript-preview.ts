import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { projectSessionDisplayMessage } from "./session-display-projection.js";

export const SESSION_ROW_TRANSCRIPT_PREVIEW_MAX_BYTES = 64 * 1024;

/** Undefined needs a tail lookup; null means the newest message exceeds that lookup's budget. */
export function projectSessionRowTranscriptPreview(
  event: unknown,
  serializedBytes: number,
): string | null | undefined {
  if (!isRecord(event) || event.type === "session" || !event.message) {
    return undefined;
  }
  if (serializedBytes > SESSION_ROW_TRANSCRIPT_PREVIEW_MAX_BYTES) {
    return null;
  }
  const projected = projectSessionDisplayMessage(event.message, { flattenMarkdown: true });
  return projected ? Buffer.from(projected.text, "utf16le").toString("utf16le") : undefined;
}
