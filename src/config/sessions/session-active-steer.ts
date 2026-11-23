import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { captureReplyMessageInjectionTarget } from "../../sessions/session-controller.message-injection.js";
import { getSessionControllerOperation } from "../../sessions/session-controller.state.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-input.types.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";

/** Read only the physical controller owner, never a catalog projection or successor. */
export function captureSessionSteeringTarget(input: {
  activeRunScopeKey?: string;
  storePath: string;
  sessionKey: string;
  agentId: string;
  backingSessionId?: string;
  sessionId?: string;
}) {
  const operation = getSessionControllerOperation(
    input.activeRunScopeKey ?? input.sessionKey,
    captureSessionTarget({
      storeScope: input.storePath,
      sessionKey: input.sessionKey,
      agentId: input.agentId,
      incarnation: input.backingSessionId ?? input.sessionId,
    }),
  );
  return operation?.sessionId === input.sessionId
    ? captureReplyMessageInjectionTarget(operation)
    : undefined;
}

/** Bind steering to one existing backend, never its successor. */
export function captureSessionActiveSteerTarget(
  input: Parameters<typeof captureSessionSteeringTarget>[0] & { runId: string },
) {
  const target = captureSessionSteeringTarget(input);
  return target?.runId === input.runId ? target : undefined;
}

export function matchesSessionSteeringSource(
  target: { sessionKey: string; sessionId: string },
  current:
    | { storePath: string; canonicalKey: string; entry: { sessionId?: string } }
    | null
    | undefined,
  admitted: { storePath: string } | null | undefined,
) {
  return Boolean(
    admitted &&
    current &&
    current.storePath === admitted.storePath &&
    current.canonicalKey === target.sessionKey &&
    current.entry.sessionId === target.sessionId,
  );
}

export function matchesSessionSteeringTarget(target: { sessionId?: string }, sessionId: string) {
  return target.sessionId === sessionId;
}

/** Retained input proves only the original operation, not permission to replay it. */
export function compareSessionActiveSteerInput(input: {
  submitted: PersistedUserTurnMessage;
  intent?: { profileId: string; sessionId?: string; runId: string };
  requestIdentity?: string;
  message: string;
}): boolean | "unverifiable" | undefined {
  const stored = asOptionalRecord(input.submitted["__openclaw"]?.activeSteer);
  if (!input.intent) {
    return stored ? true : undefined;
  }
  if (
    !stored ||
    typeof stored.profileId !== "string" ||
    typeof stored.sessionId !== "string" ||
    typeof stored.runId !== "string"
  ) {
    return "unverifiable";
  }
  if (
    stored.profileId !== input.intent.profileId ||
    stored.sessionId !== input.intent.sessionId ||
    stored.runId !== input.intent.runId
  ) {
    return true;
  }
  const identity = input.submitted["__openclaw"]?.chatRequestIdentity;
  if (typeof identity === "string") {
    return identity !== input.requestIdentity;
  }
  const text = extractTextFromChatContent(input.submitted.content, {
    joinWith: "\n",
    normalizeText: (value) => value,
  });
  return stored.textUnchanged === true && text === input.message ? false : "unverifiable";
}
