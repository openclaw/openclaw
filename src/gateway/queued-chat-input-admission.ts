import { AsyncLocalStorage } from "node:async_hooks";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
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
  operatorAuthority?: AdmittedRunOperatorAuthority;
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
