// Durable breadcrumb for in-flight ask_user_question records.
//
// The QuestionManager keeps pending questions in memory only, so a gateway
// restart drops them (and the parked tool run dies with it). This breadcrumb
// persists just enough (record id + turn source) for a startup sweep to emit
// `question.expired`, so a Control UI card or channel prompt that was showing
// the question is dismissed instead of hanging forever.
import { patchSessionEntry } from "./session-accessor.js";
import type { SessionStoreSnapshotEntry } from "./store-cache.js";
import { readSessionEntries } from "./store-load.js";
import type { SessionPendingQuestion } from "./types.js";

export type PendingQuestionScope = {
  sessionKey: string;
  storePath?: string;
};

/** Persists the pending-question breadcrumb for a session (best-effort). */
export async function recordPendingQuestion(
  scope: PendingQuestionScope,
  question: { id: string; createdAt: number; turnSourceChannel?: string | null },
): Promise<void> {
  const breadcrumb: SessionPendingQuestion = {
    schemaVersion: 1,
    id: question.id,
    createdAt: question.createdAt,
    ...(question.turnSourceChannel ? { turnSourceChannel: question.turnSourceChannel } : {}),
  };
  await patchSessionEntry({ sessionKey: scope.sessionKey, storePath: scope.storePath }, () => ({
    pendingQuestion: breadcrumb,
  }));
}

/**
 * Clears the breadcrumb, but only when it still points at `id` so a newer
 * pending question registered on the same session is not accidentally cleared.
 */
export async function clearPendingQuestion(scope: PendingQuestionScope, id: string): Promise<void> {
  await patchSessionEntry({ sessionKey: scope.sessionKey, storePath: scope.storePath }, (entry) => {
    if (!entry.pendingQuestion || entry.pendingQuestion.id !== id) {
      return null;
    }
    return { pendingQuestion: undefined };
  });
}

export type PendingQuestionBreadcrumb = {
  sessionKey: string;
  pendingQuestion: SessionPendingQuestion;
};

/** Pure scan: returns every session entry that still carries a pending breadcrumb. */
export function collectPendingQuestionBreadcrumbs(
  entries: Iterable<readonly [string, SessionStoreSnapshotEntry]>,
): PendingQuestionBreadcrumb[] {
  const breadcrumbs: PendingQuestionBreadcrumb[] = [];
  for (const [sessionKey, entry] of entries) {
    const pending = entry.pendingQuestion;
    if (pending) {
      // Rebuild a mutable copy from the (deep-readonly) snapshot fields.
      breadcrumbs.push({
        sessionKey,
        pendingQuestion: {
          schemaVersion: 1,
          id: pending.id,
          createdAt: pending.createdAt,
          ...(pending.turnSourceChannel ? { turnSourceChannel: pending.turnSourceChannel } : {}),
        },
      });
    }
  }
  return breadcrumbs;
}

/**
 * Startup sweep: emits `question.expired` for every persisted breadcrumb (whose
 * in-memory record died with the previous process) and clears it. Returns the
 * number of breadcrumbs swept.
 */
export async function sweepPendingQuestions(params: {
  storePath: string;
  emitExpired: (breadcrumb: PendingQuestionBreadcrumb) => void;
  reason?: string;
}): Promise<number> {
  let breadcrumbs: PendingQuestionBreadcrumb[];
  try {
    breadcrumbs = collectPendingQuestionBreadcrumbs(readSessionEntries(params.storePath));
  } catch {
    // A missing/unreadable store simply has nothing to sweep.
    return 0;
  }
  for (const breadcrumb of breadcrumbs) {
    try {
      params.emitExpired(breadcrumb);
    } catch {
      // A surface notification failure must not block clearing the breadcrumb.
    }
    await clearPendingQuestion(
      { sessionKey: breadcrumb.sessionKey, storePath: params.storePath },
      breadcrumb.pendingQuestion.id,
    );
  }
  return breadcrumbs.length;
}
