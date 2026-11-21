import { AsyncLocalStorage } from "node:async_hooks";
import type { ParticipationCeiling } from "../agents/participation-ceiling.js";
import type { PreparedRequesterProfile } from "../auto-reply/requester-profile.js";
import type { PersistedUserTurnMessage } from "../sessions/user-turn-input.types.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type QueuedChatInputTarget = {
  agentId: string;
  storePath: string;
  sessionKey: string;
  sessionId: string;
  inputId: string;
  runId: string;
  message: PersistedUserTurnMessage;
  requestHash: string;
};

type QueuedChatInputAdmission = {
  target: QueuedChatInputTarget;
  requestFingerprint: string;
  requesterProfile?: PreparedRequesterProfile;
  participationCeiling?: ParticipationCeiling;
};

/** Original accepted bytes retain queue custody; authority is freshly admitted by the caller. */
export const queuedChatInputAdmission = resolveGlobalSingleton(
  Symbol.for("openclaw.queuedChatInputAdmission"),
  () => new AsyncLocalStorage<QueuedChatInputAdmission>(),
);

export function readQueuedChatInputAdmission(runId: string): QueuedChatInputAdmission | undefined {
  const current = queuedChatInputAdmission.getStore();
  return current?.target.runId === runId ? current : undefined;
}

/** Only the recovery owner's exact input can use the participant method alternative. */
export function readQueuedParticipationProfile(params: unknown): string | undefined {
  if (
    !params ||
    typeof params !== "object" ||
    !("idempotencyKey" in params) ||
    typeof params.idempotencyKey !== "string"
  ) {
    return undefined;
  }
  const current = readQueuedChatInputAdmission(params.idempotencyKey);
  const ceiling = current?.participationCeiling;
  return ceiling &&
    "sessionKey" in params &&
    params.sessionKey === current.target.sessionKey &&
    "sessionId" in params &&
    params.sessionId === current.target.sessionId &&
    ceiling.sessionKey === current.target.sessionKey &&
    current.requesterProfile?.id === ceiling.profileId &&
    current.requesterProfile.isCurrent()
    ? ceiling.profileId
    : undefined;
}
