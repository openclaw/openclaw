/** Resolves and validates session-target keys used by cron jobs and delivery. */
import type { CronConversationBinding, CronDelivery } from "./types.js";

const INVALID_CRON_SESSION_TARGET_ID_ERROR = "invalid cron sessionTarget session id";

/** Returns whether an error came from cron session target id validation. */
export function isInvalidCronSessionTargetIdError(error: unknown): boolean {
  return error instanceof Error && error.message === INVALID_CRON_SESSION_TARGET_ID_ERROR;
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
 * Returns whether cron executes the job under its own `cron:<jobId>` run key. A
 * `current` job is still a child of its creating conversation; this decides only the key.
 */
export function isDetachedCronSessionTarget(sessionTarget?: string | null): boolean {
  return sessionTarget === "isolated" || sessionTarget === "current";
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

/** Preserves `current` with a creation-time sessionKey so future active UI state is irrelevant. */
export function resolveCronCurrentSessionTarget(params: {
  sessionTarget?: string | null;
  sessionKey?: string | null;
}): string | undefined {
  if (params.sessionTarget !== "current") {
    return params.sessionTarget ?? undefined;
  }
  const sessionKey = params.sessionKey?.trim();
  return sessionKey ? "current" : "isolated";
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

/** Shown when a selected result conversation has no matching Gateway capture. */
export const CRON_SELECTED_CONVERSATION_UNBOUND_MESSAGE =
  "cron delivery.sessionKey has no captured conversation; set delivery.sessionKey again with cron.update";

/**
 * The internal conversation chosen by `delivery.sessionKey`: announce results plus failure and
 * safety notices, or only those notices with `none`. `undefined`: the job uses implicit or
 * external routing. `null`: the key has no matching captured generation, so delivery must fail
 * instead of falling back to another conversation.
 */
export function resolveCronSelectedConversation(job: {
  delivery?: Pick<CronDelivery, "mode" | "sessionKey">;
  deliveryConversation?: CronConversationBinding;
}): CronConversationBinding | null | undefined {
  // Validation keeps the key on announce or none jobs; leaving those modes clears it.
  const sessionKey = job.delivery?.sessionKey;
  if (sessionKey === undefined) {
    return undefined;
  }
  return job.deliveryConversation?.sessionKey === sessionKey ? job.deliveryConversation : null;
}

type CronResultConversation = {
  sourceSessionKey?: string;
  sourceSessionGeneration?: { sessionId: string; lifecycleRevision: string | undefined };
};

/**
 * The conversation that receives a routeless result. A selected conversation replaces the
 * creator's; an unbound selection keeps no generation, so delivery fails instead of falling back.
 */
export function resolveCronResultConversation(
  job: Parameters<typeof resolveCronSelectedConversation>[0],
  creator: CronResultConversation,
): CronResultConversation {
  const selected =
    job.delivery?.mode === "announce" ? resolveCronSelectedConversation(job) : undefined;
  if (selected === undefined) {
    return {
      sourceSessionKey: creator.sourceSessionKey,
      sourceSessionGeneration: creator.sourceSessionGeneration,
    };
  }
  return selected
    ? {
        sourceSessionKey: selected.sessionKey,
        sourceSessionGeneration: {
          sessionId: selected.sessionId,
          lifecycleRevision: selected.lifecycleRevision,
        },
      }
    : { sourceSessionKey: job.delivery?.sessionKey, sourceSessionGeneration: undefined };
}
