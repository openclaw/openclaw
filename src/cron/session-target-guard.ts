import { deriveSessionChatType, parseAgentSessionKey } from "../sessions/session-key-utils.js";

function trimToOptionalString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isAgentScopedChatSessionKey(sessionKey: string): boolean {
  return parseAgentSessionKey(sessionKey) !== null;
}

export function isUnsafeCronSessionKey(sessionKey: string | null | undefined): boolean {
  const trimmed = trimToOptionalString(sessionKey);
  if (!trimmed || !isAgentScopedChatSessionKey(trimmed)) {
    return false;
  }
  return deriveSessionChatType(trimmed) === "direct";
}

export function isUnsafeCronSessionTarget(sessionTarget: string | null | undefined): boolean {
  const trimmed = trimToOptionalString(sessionTarget);
  if (!trimmed?.toLowerCase().startsWith("session:")) {
    return false;
  }
  return isUnsafeCronSessionKey(trimmed.slice(8));
}

export function normalizeCronSessionTargetForPersistence(params: {
  sessionTarget: string | null | undefined;
  currentSessionKey?: string | null;
}): string | undefined {
  const sessionTarget = trimToOptionalString(params.sessionTarget);
  if (!sessionTarget) {
    return undefined;
  }
  if (sessionTarget === "current") {
    const currentSessionKey = trimToOptionalString(params.currentSessionKey);
    if (!currentSessionKey || isUnsafeCronSessionKey(currentSessionKey)) {
      return "isolated";
    }
    return `session:${currentSessionKey}`;
  }
  if (isUnsafeCronSessionTarget(sessionTarget)) {
    return "isolated";
  }
  return sessionTarget;
}
