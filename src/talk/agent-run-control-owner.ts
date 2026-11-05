import {
  getActiveNativeAttempt,
  getEmbeddedRunAttachment,
} from "../agents/embedded-agent-runner/run-state.js";
import type { ReplyToolAuthorityOverlay } from "../sessions/session-controller.contracts.js";
import {
  getAttachedBackend,
  resolveReplyRunForCurrentSessionId,
} from "../sessions/session-controller.state.js";

/** A session-wide request selects one existing owner; later work cannot inherit it. */
export function captureRealtimeVoiceRunOwner(sessionId: string, sessionKey: string) {
  const handle = getActiveNativeAttempt(sessionId);
  const registration = handle ? getEmbeddedRunAttachment(handle) : undefined;
  const resolution = resolveReplyRunForCurrentSessionId(sessionId);
  const operation = resolution.kind === "one" ? resolution.operation : undefined;
  if (!handle && resolution.kind !== "one") {
    return undefined;
  }
  const runId = handle?.runId;
  const handleFingerprint = handle?.toolAuthorityFingerprint;
  const fingerprint = handleFingerprint ?? operation?.toolAuthorityFingerprint;
  const isCurrent = () => {
    const currentResolution = resolveReplyRunForCurrentSessionId(sessionId);
    if (
      operation &&
      (operation.result ||
        operation.key !== sessionKey ||
        operation.sessionId !== sessionId ||
        currentResolution.kind !== "one" ||
        currentResolution.operation !== operation ||
        (handle && getAttachedBackend(operation) !== handle))
    ) {
      return false;
    }
    if (
      handle &&
      (getActiveNativeAttempt(sessionId) !== handle ||
        getEmbeddedRunAttachment(handle) !== registration ||
        (registration?.sessionKey !== undefined && registration.sessionKey !== sessionKey) ||
        handle.runId !== runId ||
        handle.toolAuthorityFingerprint !== handleFingerprint ||
        handle.isStopped?.() ||
        handle.isAborted?.())
    ) {
      return false;
    }
    try {
      registration?.toolAuthority?.assertActive();
      return true;
    } catch {
      return false;
    }
  };
  return {
    operation,
    isCurrent,
    // Released external V2 sinks retain synchronous policy checks at their final effect.
    matchesCaller: (overlay: ReplyToolAuthorityOverlay) => {
      if (!isCurrent()) {
        return false;
      }
      const projected = registration?.toolAuthority
        ? registration.toolAuthority.project(overlay)
        : operation?.projectToolAuthorityFingerprint(overlay);
      return Boolean(fingerprint && projected === fingerprint && isCurrent());
    },
  };
}
