import {
  assertProviderReviewAcknowledgment,
  type ProviderReviewAcknowledgment,
} from "../../sessions/provider-review.js";
import {
  resolveIncognitoSessionExpiresAt,
  isIncognitoSessionKey,
} from "../../shared/incognito-session-key.js";
import type { SessionRestartResume } from "./restart-resume.js";
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
  restartResume?: SessionRestartResume;
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

type SessionWorkStartBlockReason =
  | "deleted"
  | "changed"
  | "expired"
  | "initialization_pending"
  | "provider_review"
  | "restart_tombstone"
  | "archived"
  | "workspace_pending";

export class SessionWorkStartError extends Error {
  override name = "SessionWorkStartError";

  constructor(
    readonly reason: SessionWorkStartBlockReason,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

/** One work-start policy supplies both user errors and recovery disposition. */
export function resolveSessionWorkStartBlock(
  sessionKey: string,
  entry: SessionWorkStartEntry | null | undefined,
  options?: SessionWorkStartOptions,
): SessionWorkStartError | undefined {
  return resolveWorkStartBlock(sessionKey, entry, options);
}

function resolveWorkStartBlock(
  sessionKey: string,
  entry: SessionWorkStartEntry | null | undefined,
  options?: SessionWorkStartOptions,
  acceptedRecoveryNotice = false,
): SessionWorkStartError | undefined {
  if (options?.expectedSessionId && !entry) {
    return new SessionWorkStartError(
      "deleted",
      `Session "${sessionKey}" was deleted while starting work. Retry.`,
    );
  }
  if (options?.expectedSessionId && entry?.sessionId !== options.expectedSessionId) {
    return new SessionWorkStartError(
      "changed",
      `Session "${sessionKey}" changed while starting work. Retry.`,
    );
  }
  const incognitoExpiresAt = entry ? resolveIncognitoSessionExpiresAt(entry) : undefined;
  if (
    (entry?.incognito || isIncognitoSessionKey(sessionKey)) &&
    incognitoExpiresAt !== undefined &&
    Date.now() >= incognitoExpiresAt
  ) {
    return new SessionWorkStartError(
      "expired",
      `Incognito session "${sessionKey}" expired. Start a new Incognito session.`,
    );
  }
  if (entry?.initializationPending === true) {
    return new SessionWorkStartError(
      "initialization_pending",
      `Session "${sessionKey}" is still initializing. Retry after initialization completes.`,
      true,
    );
  }
  if (entry?.providerReview && options?.purpose !== "accepted-result-settlement") {
    try {
      if (!options?.providerReviewAcknowledgment) {
        return new SessionWorkStartError(
          "provider_review",
          `Session "${sessionKey}" is paused as a precaution. Review the provider findings in chat before continuing.`,
        );
      }
      assertProviderReviewAcknowledgment(options.providerReviewAcknowledgment, {
        sessionKey,
        entry,
        runId: options.runId,
      });
    } catch {
      return new SessionWorkStartError(
        "provider_review",
        `Session "${sessionKey}" provider review changed. Refresh the findings before continuing.`,
      );
    }
  }
  const restartRecoveryTombstone = isRestartRecoveryTombstone(entry);
  if (restartRecoveryTombstone) {
    const resume = options?.restartResume;
    const canResume = Boolean(
      resume &&
      !entry?.providerReview &&
      entry?.archivedAt === undefined &&
      entry?.sessionId === resume.sessionId &&
      entry.lifecycleRevision === resume.lifecycleRevision &&
      entry.mainRestartRecovery?.cycleId === resume.expectedState.mainRestartRecoveryCycleId &&
      entry.mainRestartRecovery?.revision === resume.expectedState.mainRestartRecoveryRevision &&
      !entry.mainRestartRecovery?.tombstone?.recoveredSessionKey,
    );
    // Acknowledgment owns continuation of the reviewed conversation, never its replacement.
    if (options?.allowRestartTombstoneReplacement === true && !entry?.providerReview) {
      return undefined;
    }
    if (!canResume && !acceptedRecoveryNotice) {
      return new SessionWorkStartError(
        "restart_tombstone",
        entry?.modelSelectionLocked === true
          ? `Session "${sessionKey}" ended during restart recovery and cannot be replaced while model selection is locked. Open it in WebChat and use Resume.`
          : `Session "${sessionKey}" ended during restart recovery. Use Resume in WebChat, or /new or /reset to start a replacement session.`,
      );
    }
  }
  if (entry?.archivedAt !== undefined) {
    return new SessionWorkStartError(
      "archived",
      `Session "${sessionKey}" is archived. Restore it before starting new work.`,
    );
  }
  if (
    !options?.allowPendingWorkspace &&
    (entry?.pendingProjectGitUrl !== undefined || entry?.pendingWorktree !== undefined)
  ) {
    return new SessionWorkStartError(
      "workspace_pending",
      `Session "${sessionKey}" workspace is not ready. Wait for setup to finish or retry in chat.`,
      true,
    );
  }
  return undefined;
}

export function resolveSessionWorkStartError(
  sessionKey: string,
  entry: SessionWorkStartEntry | null | undefined,
  options?: SessionWorkStartOptions,
): string | undefined {
  return resolveSessionWorkStartBlock(sessionKey, entry, options)?.message;
}

/** Only confirmation of this exact tombstone's notice may settle through its closed lifecycle. */
export function resolveRecoveryNoticeSettlementError(
  sessionKey: string,
  entry: SessionWorkStartEntry,
  notice: { cycleId: string; revision: number },
): string | undefined {
  const recovery = entry.mainRestartRecovery;
  if (
    !recovery?.tombstone ||
    recovery.cycleId !== notice.cycleId ||
    recovery.revision !== notice.revision ||
    recovery.tombstone.recoveredSessionKey
  ) {
    return "restart recovery notice no longer owns this tombstone";
  }
  return resolveWorkStartBlock(sessionKey, entry, { purpose: "accepted-result-settlement" }, true)
    ?.message;
}
