import { hasPendingFollowupQueueWork } from "../../auto-reply/reply/queue/state.js";
import { replyRunRegistry } from "../../auto-reply/reply/reply-run-registry.js";
import { retireProviderReviewAcknowledgment } from "../../sessions/provider-review.js";
import {
  isCompetingSessionWorkAdmissionActive,
  type SessionWorkAdmissionLease,
} from "../../sessions/session-lifecycle-admission.js";
import { formatForLog } from "../ws-log.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import type { GatewayRequestContext } from "./types.js";

/** Caller and physical target custody end together when admitted work settles. */
export function releaseChatSendCallerAuthority(params: {
  operator: { release?: () => void };
  request: Pick<NormalizedChatSendRequest, "providerReviewAcknowledgment">;
  session: Pick<PreparedChatSendSession, "releaseSessionTarget">;
}): void {
  try {
    params.operator.release?.();
  } finally {
    try {
      if (params.request.providerReviewAcknowledgment) {
        retireProviderReviewAcknowledgment(params.request.providerReviewAcknowledgment);
      }
    } finally {
      params.session.releaseSessionTarget();
    }
  }
}

/** Queued and collected turns share the original session and caller admission until settlement. */
export function createChatSendWorkAdmission(params: {
  admission: Pick<SessionWorkAdmissionLease, "release">;
  releaseCallerAuthority?: () => void;
  logGateway: Pick<GatewayRequestContext["logGateway"], "warn">;
}) {
  let references = 1;
  const cleanups: Array<() => void> = [];
  const release = () => {
    if (references === 0) {
      return;
    }
    references -= 1;
    if (references !== 0) {
      return;
    }
    try {
      for (const cleanup of cleanups.splice(0)) {
        try {
          cleanup();
        } catch (error) {
          // One failed disposition write must not strand another retained resource.
          params.logGateway.warn(`Failed to clean up retained chat work: ${formatForLog(error)}`);
        }
      }
    } finally {
      try {
        params.admission.release();
      } finally {
        params.releaseCallerAuthority?.();
      }
    }
  };
  const hold = () => {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      release();
    };
  };
  return {
    isActive: () => references > 0,
    release: hold(),
    retain: () => {
      if (references === 0) {
        throw new Error("cannot retain a released chat work admission");
      }
      references += 1;
      return hold();
    },
    addCleanup: (cleanup: () => void) => {
      if (references === 0) {
        cleanup();
      } else {
        cleanups.push(cleanup);
      }
    },
  };
}

/** Rechecked inside the session writer barrier before exclusive input is admitted. */
export function assertChatSendExclusiveAdmission(
  request: NormalizedChatSendRequest,
  session: PreparedChatSendSession,
): void {
  if (!request.goalOperation && !request.providerReviewAcknowledgment) {
    return;
  }
  const { storePath, sessionKey, backingSessionId, activeRunScopeKey } = session;
  if (
    isCompetingSessionWorkAdmissionActive(storePath, [sessionKey, backingSessionId]) ||
    hasPendingFollowupQueueWork([sessionKey, backingSessionId, activeRunScopeKey]) ||
    replyRunRegistry.isActive(activeRunScopeKey)
  ) {
    throw new Error(
      request.providerReviewAcknowledgment
        ? "The session still has active work. Review its status before continuing."
        : "goal-session-busy",
    );
  }
}
