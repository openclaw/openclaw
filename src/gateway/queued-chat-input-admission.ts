import { AsyncLocalStorage } from "node:async_hooks";
import type { PreparedRequesterProfile } from "../auto-reply/requester-profile.js";
import type { PersistedUserTurnMessage } from "../sessions/user-turn-transcript.types.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type QueuedChatInputTarget = {
  agentId: string;
  storePath: string;
  sessionKey: string;
  sessionId: string;
  runId: string;
  message: PersistedUserTurnMessage;
  requestHash: string;
};

type QueuedChatInputAdmission = {
  target: QueuedChatInputTarget;
  requestFingerprint: string;
  requesterProfile?: PreparedRequesterProfile;
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
