import {
  assertProviderReviewAcknowledgment,
  type ProviderReviewAcknowledgment,
} from "../../sessions/provider-review.js";
import {
  resolveIncognitoSessionExpiresAt,
  isIncognitoSessionKey,
} from "../../shared/incognito-session-key.js";
import type { InternalSessionEntry } from "./types.js";

type SessionWorkStartEntry = Pick<
  InternalSessionEntry,
  | "archivedAt"
  | "createdAt"
  | "incognito"
  | "initializationPending"
  | "mainRestartRecovery"
  | "modelSelectionLocked"
  | "sessionId"
  | "pendingProjectGitUrl"
  | "pendingWorktree"
  | "providerReview"
  | "lifecycleRevision"
> &
  Partial<Pick<InternalSessionEntry, "updatedAt">>;

type SessionWorkStartOptions = {
  /** Already-accepted transcript/delivery results settle without dispatching new model work. */
  purpose?: "accepted-result-settlement";
  allowRestartTombstoneReplacement?: boolean;
  expectedSessionId?: string;
  /** Only workspace preparers and lifecycle cancellation may enter pending sessions. */
  allowPendingWorkspace?: true;
  providerReviewAcknowledgment?: ProviderReviewAcknowledgment;
  runId?: string;
};

export function isRestartRecoveryTombstone(
  entry: SessionWorkStartEntry | null | undefined,
): boolean {
  return entry?.mainRestartRecovery?.tombstone !== undefined;
}

/** Stable Gateway error detail for stale session lifecycle requests. */
export const SESSION_LIFECYCLE_CHANGED_ERROR_REASON = "session-changed";

/** Lifecycle-owned expired, initializing, restart-tombstoned, and archived sessions reject work. */
export function resolveSessionWorkStartError(
  sessionKey: string,
  entry: SessionWorkStartEntry | null | undefined,
  options?: SessionWorkStartOptions,
): string | undefined {
  if (options?.expectedSessionId && !entry) {
    return `Session "${sessionKey}" was deleted while starting work. Retry.`;
  }
  if (options?.expectedSessionId && entry?.sessionId !== options.expectedSessionId) {
    return `Session "${sessionKey}" changed while starting work. Retry.`;
  }
  const incognitoExpiresAt = entry ? resolveIncognitoSessionExpiresAt(entry) : undefined;
  if (
    (entry?.incognito || isIncognitoSessionKey(sessionKey)) &&
    incognitoExpiresAt !== undefined &&
    Date.now() >= incognitoExpiresAt
  ) {
    return `Incognito session "${sessionKey}" expired. Start a new Incognito session.`;
  }
  if (entry?.initializationPending === true) {
    return `Session "${sessionKey}" is still initializing. Retry after initialization completes.`;
  }
  if (entry?.providerReview && options?.purpose !== "accepted-result-settlement") {
    try {
      if (!options?.providerReviewAcknowledgment) {
        return `Session "${sessionKey}" is paused as a precaution. Review the provider findings in chat before continuing.`;
      }
      assertProviderReviewAcknowledgment(options.providerReviewAcknowledgment, {
        sessionKey,
        entry,
        runId: options.runId,
      });
    } catch {
      return `Session "${sessionKey}" provider review changed. Refresh the findings before continuing.`;
    }
  }
  const restartRecoveryTombstone = isRestartRecoveryTombstone(entry);
  if (restartRecoveryTombstone) {
    // Acknowledgment owns continuation of the reviewed conversation, never its replacement.
    if (options?.allowRestartTombstoneReplacement === true && !entry?.providerReview) {
      return undefined;
    }
    return entry?.modelSelectionLocked === true
      ? `Session "${sessionKey}" ended during restart recovery and cannot be replaced while model selection is locked. Open it in WebChat and use Resume in new session.`
      : `Session "${sessionKey}" ended during restart recovery. Use /new or /reset to start a replacement session.`;
  }
  if (entry?.archivedAt !== undefined) {
    return `Session "${sessionKey}" is archived. Restore it before starting new work.`;
  }
  if (
    !options?.allowPendingWorkspace &&
    (entry?.pendingProjectGitUrl !== undefined || entry?.pendingWorktree !== undefined)
  ) {
    return `Session "${sessionKey}" workspace is not ready. Wait for setup to finish or retry in chat.`;
  }
  return undefined;
}
