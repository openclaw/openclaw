/** Resolves and validates session-target keys used by cron jobs and delivery. */

const INVALID_CRON_SESSION_TARGET_ID_ERROR = "invalid cron sessionTarget session id";
export const INVALID_CRON_SESSION_TARGET_ERROR =
  'Expected cron sessionTarget "isolated" or "session:<key>"';

/** Returns whether an error came from cron session target id validation. */
export function isInvalidCronSessionTargetIdError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === INVALID_CRON_SESSION_TARGET_ID_ERROR ||
      error.message === INVALID_CRON_SESSION_TARGET_ERROR)
  );
}

/** Validates the opaque session id portion of a `session:` cron target. */
export function assertSafeCronSessionTargetId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (!trimmed) {
    throw new Error(INVALID_CRON_SESSION_TARGET_ID_ERROR);
  }
  if (trimmed.includes("\0")) {
    throw new Error(INVALID_CRON_SESSION_TARGET_ID_ERROR);
  }
  return trimmed;
}

/** Extracts the persistent session key from a `session:` cron target, if present. */
export function resolveCronSessionTargetSessionKey(
  sessionTarget?: string | null,
): string | undefined {
  if (typeof sessionTarget !== "string" || !sessionTarget.startsWith("session:")) {
    return undefined;
  }
  return assertSafeCronSessionTargetId(sessionTarget.slice(8));
}

/**
 * The conversation a job continues in place. Its run starts only after that conversation's own
 * turn ends, even when the job has no captured operator source.
 */
export function resolveCronContinuationSessionKey(job: {
  sessionTarget?: string | null;
}): string | undefined {
  return resolveCronSessionTargetSessionKey(job.sessionTarget);
}

/** Whether cron executes the job under its own `cron:<jobId>` run key. */
export function isDetachedCronSessionTarget(sessionTarget?: string | null): boolean {
  return sessionTarget === "isolated";
}

/**
 * Whether a captured operator source's session is this job's parent: the session
 * an in-session job runs in, or the conversation a detached child reports to.
 */
export function isCronOperatorSourceParent(
  job: {
    sessionTarget?: string | null;
    sourceConversation?: { sessionKey: string };
  },
  sessionKey: string,
): boolean {
  if (job.sessionTarget === `session:${sessionKey}`) {
    return true;
  }
  return (
    isDetachedCronSessionTarget(job.sessionTarget) &&
    job.sourceConversation?.sessionKey === sessionKey
  );
}

/** Result conversation selection is independent from the execution session and channel target. */
export function resolveCronDeliverySessionKey(job: {
  sessionTarget?: string | null;
  sessionKey?: string | null;
  sourceConversation?: { sessionKey: string };
}): string | undefined {
  const conversationKey = job.sourceConversation?.sessionKey.trim();
  if (conversationKey) {
    return conversationKey;
  }
  const sessionTargetKey = resolveCronSessionTargetSessionKey(job.sessionTarget);
  if (sessionTargetKey) {
    return sessionTargetKey;
  }

  return typeof job.sessionKey === "string" && job.sessionKey.trim()
    ? job.sessionKey.trim()
    : undefined;
}
