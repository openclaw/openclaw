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
  exitDurationMs?: number;
};

export type ChatTypingActorView = Omit<ChatTypingActorState, "retireAt"> & {
  id: string;
};

export type ChatTypingOverflow = {
  // More than five active overflow collaborators share the bounded avatar sample.
  several: true;
};

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
