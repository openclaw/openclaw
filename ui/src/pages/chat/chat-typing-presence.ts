import { asNullableRecord as recordOrNull } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString as stringValue } from "@openclaw/normalization-core/string-coerce";
import { readTranscriptSenderIdentity } from "../../../../src/chat/sender-identity.js";
import { readSessionChangedEvent } from "../../lib/sessions/reconcile.ts";
import { uiSessionEventMatches } from "../../lib/sessions/session-key.ts";

export type ChatTypingActorState = {
  label: string;
  expiresAt: number;
  preview?: string;
  exitDurationMs?: number;
};

export type ChatTypingActorView = Omit<ChatTypingActorState, "expiresAt"> & {
  id: string;
  paused?: boolean;
};

export function clearTypingActorForSessionMessage(
  payload: unknown,
  actors: Map<string, unknown>,
  timers: Map<string, number>,
  sessionHost: Parameters<typeof uiSessionEventMatches>[0],
): boolean {
  const event = readSessionChangedEvent(payload);
  if (!event || !uiSessionEventMatches(sessionHost, event.key, event.agentId ?? undefined)) {
    return false;
  }
  const message = recordOrNull(recordOrNull(payload)?.message);
  if (stringValue(message?.role)?.toLowerCase() !== "user") {
    return false;
  }
  const identity = readTranscriptSenderIdentity(
    recordOrNull(message?.["__openclaw"])?.senderIdentity,
  );
  const actorId = identity?.type === "profile" ? identity.id : undefined;
  if (!actorId || !actors.delete(actorId)) {
    return false;
  }
  const timer = timers.get(actorId);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timers.delete(actorId);
  }
  return true;
}
