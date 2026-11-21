import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { captureReplyMessageInjectionTarget } from "../../sessions/session-controller.message-injection.js";
import { getSessionControllerOperation } from "../../sessions/session-controller.state.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-input.types.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";

/** The session owner binds steering to one existing backend, never its successor. */
export function captureSessionActiveSteerTarget(input: {
  activeRunScopeKey: string;
  storePath: string;
  sessionKey: string;
  agentId: string;
  backingSessionId?: string;
  sessionId?: string;
  runId: string;
}) {
  const operation = getSessionControllerOperation(
    input.activeRunScopeKey,
    captureSessionTarget({
      storeScope: input.storePath,
      sessionKey: input.sessionKey,
      agentId: input.agentId,
      incarnation: input.backingSessionId,
    }),
  );
  const target = captureReplyMessageInjectionTarget(operation);
  return target?.runId === input.runId && operation?.sessionId === input.sessionId
    ? target
    : undefined;
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
