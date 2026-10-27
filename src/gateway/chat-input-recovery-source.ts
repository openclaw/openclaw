import { AsyncLocalStorage } from "node:async_hooks";
import type { PreparedRequesterProfile } from "../auto-reply/requester-profile.js";
import type { PersistedUserTurnMessage } from "../sessions/user-turn-transcript.types.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export const CHAT_INPUT_RECOVERY_MAX_AGE_MS = 24 * 60 * 60_000;

export type ChatInputRecoveryTarget = {
  agentId: string;
  storePath: string;
  sessionKey: string;
  sessionId: string;
  runId: string;
  message: PersistedUserTurnMessage;
  requestHash: string;
};

type ChatInputRecoveryAdmission = {
  target: ChatInputRecoveryTarget;
  requestFingerprint: string;
  suppressCommandInterpretation: boolean;
  requesterProfile?: PreparedRequesterProfile;
};

export const chatInputRecoveryAdmission = resolveGlobalSingleton(
  Symbol.for("openclaw.chatInputRecoveryAdmission"),
  () => new AsyncLocalStorage<ChatInputRecoveryAdmission>(),
);

export function readChatInputRecoveryAdmission(
  runId: string,
): ChatInputRecoveryAdmission | undefined {
  const current = chatInputRecoveryAdmission.getStore();
  return current?.target.runId === runId ? current : undefined;
}
