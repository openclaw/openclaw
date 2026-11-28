import { asNullableRecord as recordOrNull } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString as stringValue } from "@openclaw/normalization-core/string-coerce";
import { readTranscriptSenderIdentity } from "../../../../src/chat/sender-identity.js";
import { readSessionChangedEvent } from "../../lib/sessions/reconcile.ts";
import { uiSessionEventMatches } from "../../lib/sessions/session-key.ts";

export type ChatTypingActorState = {
  label: string;
  retireAt: number;
  paused?: boolean;
  preview?: string;
  cursor?: number;
  exitDurationMs?: number;
};

export type ChatTypingActorView = Omit<ChatTypingActorState, "retireAt"> & {
  id: string;
};

export type ChatTypingOverflow = {
  // More than five active overflow collaborators share the bounded avatar sample.
  several: true;
};

// Keep the caret inside the bounded preview, without trimming whitespace or
// splitting a Unicode code point. The wire offset uses textarea UTF-16 units.
export function typingDraftPreview(text: string, cursor = text.length) {
  if (!text.trim()) {
    return undefined;
  }
  const points = Array.from(text);
  let caretPoint = 0;
  let offset = 0;
  while (caretPoint < points.length && offset + points[caretPoint]!.length <= cursor) {
    offset += points[caretPoint++]!.length;
  }
  const start = Math.max(0, Math.min(caretPoint - 150, points.length - 300));
  return {
    preview: points.slice(start, start + 300).join(""),
    cursor: points.slice(start, caretPoint).join("").length,
  };
}

export function typingActorIdForSessionMessage(
  payload: unknown,
  sessionHost: Parameters<typeof uiSessionEventMatches>[0],
): string | undefined {
  const event = readSessionChangedEvent(payload);
  if (!event || !uiSessionEventMatches(sessionHost, event.key, event.agentId ?? undefined)) {
    return undefined;
  }
  const message = recordOrNull(recordOrNull(payload)?.message);
  if (stringValue(message?.role)?.toLowerCase() !== "user") {
    return undefined;
  }
  const identity = readTranscriptSenderIdentity(
    recordOrNull(message?.["__openclaw"])?.senderIdentity,
  );
  return identity?.type === "profile" ? identity.id : undefined;
}
