import {
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.sqlite-entry.js";
import { loadTranscriptReadSnapshotSync } from "../../config/sessions/session-accessor.sqlite-read.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { readTranscriptContextVersionInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-state.js";
import { appendTranscriptMessageSnapshotSync } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readTranscriptMessageIdempotencyKey } from "../session-transcript-entry-message.js";
import {
  isCommittedAgentMessage,
  prepareTranscriptCommitFromSnapshot,
  type PreparedTranscriptCommit,
} from "./transcript-commit-policy.js";
import type {
  ApplyTranscriptCommitResult,
  CommittedAgentMessage,
  TranscriptCommitInput,
} from "./transcript-commit.types.js";

export function prepareTranscriptCommit(input: TranscriptCommitInput): PreparedTranscriptCommit {
  return prepareTranscriptCommitFromSnapshot(input, loadSessionEntry(input.scope), () =>
    loadTranscriptReadSnapshotSync(input.scope),
  );
}

/** The caller owns one synchronous transaction around validation, append, and metadata. */
export function applyPreparedTranscriptCommit(
  input: TranscriptCommitInput,
  plan: PreparedTranscriptCommit,
  freshMessages: readonly CommittedAgentMessage[],
  onProjectionReconcileNeeded: () => void,
): ApplyTranscriptCommitResult {
  if (!plan.result.ok) {
    return plan.result;
  }
  const currentEntry = loadSessionEntry(input.scope);
  if (!currentEntry || currentEntry.sessionId !== input.scope.sessionId) {
    return { ok: false, reason: "session-not-attached" };
  }
  if (currentEntry.lifecycleRevision !== plan.result.lifecycleRevision) {
    return { ok: false, reason: "invalid-batch" };
  }
  const database = openOpenClawAgentDatabase(
    toDatabaseOptions(resolveSqliteTranscriptScope(input.scope)),
  );
  const version = readTranscriptContextVersionInTransaction(database, input.scope.sessionId);
  if (
    !plan.version ||
    version.generation !== plan.version.generation ||
    version.rawSeq !== plan.version.rawSeq ||
    version.updatedAt !== plan.version.updatedAt
  ) {
    return { ok: false, reason: "stale-base-leaf" };
  }
  if (plan.result.messages.length === input.messages.length) {
    return plan.result;
  }
  const recoveredCount = plan.result.messages.length;
  if (
    freshMessages.length !== input.messages.length - recoveredCount ||
    !freshMessages.every(
      (message, index) =>
        isCommittedAgentMessage(message) &&
        readTranscriptMessageIdempotencyKey(message)?.trim() ===
          readTranscriptMessageIdempotencyKey(input.messages[recoveredCount + index])?.trim(),
    )
  ) {
    return { ok: false, reason: "invalid-batch" };
  }
  const messages = [...plan.result.messages];
  let parentId = plan.parentId;
  let nextMessageSeq = plan.nextMessageSeq;
  for (const message of freshMessages) {
    const snapshot = appendTranscriptMessageSnapshotSync(
      input.scope,
      {
        message,
        cwd: input.cwd,
        parentId,
        appendIntent: "active-branch",
        idempotencyLookup: "caller-checked",
      },
      undefined,
      {
        scheduleProjectionReconcile: false,
        onProjectionReconcileNeeded,
      },
    );
    if (!snapshot.ok || !snapshot.value.result?.appended) {
      throw new Error("Worker transcript message was not persisted", {
        cause: snapshot.ok ? undefined : snapshot.error,
      });
    }
    const result = snapshot.value.result;
    parentId = result.messageId;
    nextMessageSeq += 1;
    messages.push({
      appended: true,
      message: result.message,
      messageId: result.messageId,
      messageSeq: nextMessageSeq,
    });
  }
  const entry = loadSessionEntry(input.scope);
  if (
    !entry ||
    entry.sessionId !== input.scope.sessionId ||
    entry.lifecycleRevision !== plan.result.lifecycleRevision
  ) {
    throw new Error("Worker transcript session changed inside its transaction");
  }
  replaceSessionEntrySync(input.scope, {
    ...entry,
    updatedAt: Math.max(entry.updatedAt ?? 0, Date.now()),
  });
  return { ...plan.result, messages };
}
