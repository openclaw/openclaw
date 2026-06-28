// Centralizes user-facing failure copy for external agent runner errors.
import { STREAM_ERROR_FALLBACK_TEXT } from "../../agents/stream-message-shared.js";

export const GENERIC_EXTERNAL_RUN_FAILURE_TEXT =
  "⚠️ Something went wrong while processing your request. Please try again, or use /new to start a fresh session.";

export const HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT =
  "⚠️ Heartbeat check failed before it could produce an update. The main chat session remains available.";

/** True when text is exactly the generic external run failure copy. */
function isGenericExternalRunFailureText(text: string | undefined): boolean {
  return text?.trim() === GENERIC_EXTERNAL_RUN_FAILURE_TEXT;
}

/**
 * True when text consists only of stream-error placeholder repetitions and
 * whitespace. A fallback model can echo `[assistant turn failed before
 * producing content]` from prior transcript entries as a "successful" final
 * reply (stopReason=stop); such text must never reach heartbeat delivery.
 */
function isStreamErrorPlaceholderOnlyText(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return false;
  }
  // The placeholder has no regex-special characters, so a direct split is safe.
  const parts = collapsed.split(STREAM_ERROR_FALLBACK_TEXT);
  return parts.every((part) => part.trim() === "");
}

/** Replaces trailing generic failure text with heartbeat-specific copy. */
export function replaceGenericExternalRunFailureText(text: string): {
  text: string;
  replaced: boolean;
} {
  if (isGenericExternalRunFailureText(text)) {
    return { text: HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT, replaced: true };
  }

  if (isStreamErrorPlaceholderOnlyText(text)) {
    return { text: HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT, replaced: true };
  }

  const genericStart = text.indexOf(GENERIC_EXTERNAL_RUN_FAILURE_TEXT);
  if (genericStart < 0) {
    return { text, replaced: false };
  }

  const trailing = text.slice(genericStart + GENERIC_EXTERNAL_RUN_FAILURE_TEXT.length).trim();
  if (trailing) {
    return { text, replaced: false };
  }

  const prefix = text.slice(0, genericStart).trimEnd();
  return {
    text: prefix
      ? `${prefix} ${HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT}`
      : HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
    replaced: true,
  };
}
