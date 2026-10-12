import { getOwedHarnessCompletionTask } from "../../agents/agent-harness-completion-recovery.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { captureIncognitoSessionSource } from "../../config/sessions/session-incognito-binding.js";
import { logVerbose } from "../../globals.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import {
  getReplyPayloadMetadata,
  type ReplyPayload,
  type SessionWriterDeliveryAuthority,
} from "../reply-payload.js";

/** Capture before preparation yields; absence and ended actors never enter native discovery. */
export function captureSessionWriterDeliveryRead(
  target: Pick<SessionWriterDeliveryAuthority, "agentId" | "sessionKey" | "storePath">,
): SessionWriterDeliveryAuthority["readCurrentSession"] {
  const source = captureIncognitoSessionSource(target);
  if (!source) {
    return undefined;
  }
  const sessionKey = target.sessionKey;
  return () => {
    if ("kind" in source) {
      source.assertCurrent();
      return undefined;
    }
    return source.actor.sessions.readSteering(sessionKey);
  };
}

class SessionWriterDeliveryRevokedError extends PlatformMessageNotDispatchedError {
  constructor() {
    super("Session writer changed before final reply delivery", {
      cause: undefined,
      retryable: false,
    });
    this.name = "SessionWriterDeliveryRevokedError";
  }
}

function isAuthorityCurrent(
  authority: SessionWriterDeliveryAuthority,
  fallbackStorePath?: string,
): boolean {
  const storePath = authority.storePath ?? fallbackStorePath;
  const current = authority.readCurrentSession
    ? authority.readCurrentSession()
    : storePath
      ? loadSessionEntryReadOnly({
          ...(authority.agentId ? { agentId: authority.agentId } : {}),
          readConsistency: "latest",
          sessionKey: authority.sessionKey,
          storePath,
        })
      : undefined;
  if (
    !current ||
    current.sessionId !== authority.expectedSessionId ||
    (authority.expectedLifecycleRevision !== undefined &&
      current.lifecycleRevision !== authority.expectedLifecycleRevision) ||
    (authority.expectedWriterRunId !== undefined &&
      current.activeWriterRunId !== authority.expectedWriterRunId)
  ) {
    return false;
  }
  const claim = authority.harnessCompletion;
  if (
    claim &&
    (claim.requesterSessionKey !== authority.sessionKey ||
      (authority.agentId !== undefined && claim.requesterAgentId !== authority.agentId))
  ) {
    return false;
  }
  try {
    // A queued final owns transport custody after execution cleanup. Keep the
    // exact task/outcome and session fence, not the now-retired input claim.
    return !claim || Boolean(getOwedHarnessCompletionTask(claim, current));
  } catch {
    return false;
  }
}

/** Revalidates a settled final payload against the latest committed session writer. */
export function isDispatchFinalReplySessionWriterAuthorized(
  payload: ReplyPayload,
  fallbackStorePath?: string,
  fallbackSessionKey?: string,
): boolean {
  const authority = getReplyPayloadMetadata(payload)?.sessionWriterDeliveryAuthority;
  if (!authority) {
    return true;
  }
  const authorized = isAuthorityCurrent(authority, fallbackStorePath);
  if (!authorized) {
    logVerbose(
      `final reply skipped after session writer replacement (session=${fallbackSessionKey ?? authority.sessionKey})`,
    );
  }
  return authorized;
}

/** Fails closed at the provider's last pre-I/O boundary when writer ownership changed. */
export function assertSessionWriterDeliveryAuthorized(
  authority: SessionWriterDeliveryAuthority | undefined,
  fallbackStorePath?: string,
): void {
  if (authority && !isAuthorityCurrent(authority, fallbackStorePath)) {
    throw new SessionWriterDeliveryRevokedError();
  }
}

/** Fails closed at the provider's last pre-I/O boundary for an authority-bearing payload. */
export function assertReplyPayloadSessionWriterDeliveryAuthorized(
  payload: ReplyPayload,
  fallbackStorePath?: string,
): void {
  const authority = getReplyPayloadMetadata(payload)?.sessionWriterDeliveryAuthority;
  assertSessionWriterDeliveryAuthorized(authority, fallbackStorePath);
}
