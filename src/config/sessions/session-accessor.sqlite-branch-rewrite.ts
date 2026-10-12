import type {
  SessionEntry,
  SessionLeafControl,
} from "../../agents/sessions/session-manager-types.js";
import {
  deferOpenClawAgentPostCommitPublication,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import type {
  SessionTranscriptContextVersion,
  SessionTranscriptWriteScope,
} from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { withSessionPendingInputRelocation } from "./session-accessor.sqlite-pending-inputs.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { appendTranscriptMessageInTransaction } from "./session-accessor.sqlite-transcript-message-append.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import {
  appendTranscriptEventInTransaction,
  redactTranscriptMessageForStorage,
} from "./session-accessor.sqlite-transcript-store.js";
import { resolveTranscriptAppendRefusal } from "./session-accessor.sqlite-transcript-write-guard.js";
import {
  assertOwnedTranscriptWriteCommit,
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWriterFence,
} from "./transcript-write-context.js";

/** The session owner prepares payloads; the transaction checks their source version once. */
export function prepareTranscriptRewriteSync(
  scope: SessionTranscriptWriteScope,
  assertActive: () => void,
  loadedVersion: SessionTranscriptContextVersion | undefined,
  admit?: (stage: "transaction" | "commit") => void,
  preparation?: {
    messagesAlreadyRedacted: true;
    scheduleProjectionReconcile?: boolean;
    onProjectionReconcileNeeded?: () => void;
  },
): (
  entries: Array<SessionEntry | SessionLeafControl>,
  sources: ReadonlyMap<string, SessionEntry>,
  adopt: (version: SessionTranscriptContextVersion) => void,
) => void {
  const fencedScope = withOwnedSessionTranscriptWriterFence(scope);
  const resolved = resolveSqliteTranscriptScope(fencedScope);
  const options = toDatabaseOptions(resolved);
  const database = openOpenClawAgentDatabase(options);
  if (database.db.isTransaction) {
    throw new Error(
      "Transcript rewrite must own its commit; run it outside the active transaction",
    );
  }
  assertActive();
  assertOwnedTranscriptWriteCommit(fencedScope);
  const conflict = () => new Error("Session transcript changed before rewrite publication");
  if (!loadedVersion) {
    throw conflict();
  }
  return (entries, sources, adopt) => {
    // A savepoint cannot own admission validation or publication at a later outer commit.
    if (openOpenClawAgentDatabase(options).db.isTransaction) {
      throw new Error(
        "Transcript rewrite must own its commit; run it outside the active transaction",
      );
    }
    // Worker rewrites retain the host's prepared bytes; diagnostic redaction is not idempotent.
    if (!preparation?.messagesAlreadyRedacted) {
      for (const entry of entries) {
        if (entry.type === "message") {
          entry.message = redactTranscriptMessageForStorage(entry.message, {});
        }
      }
    }
    let committedVersion: SessionTranscriptContextVersion;
    runOpenClawAgentWriteTransaction(
      (current) => {
        admit?.("transaction");
        // Custody stages commit first; insert observers must also see the committed manager view.
        // The version is assigned before COMMIT; rollback discards this publication.
        if (!deferOpenClawAgentPostCommitPublication(current, () => adopt(committedVersion))) {
          throw new Error("Transcript rewrite requires a commit publication");
        }
        assertActive();
        assertOwnedTranscriptWriteCommit(fencedScope);
        const fresh = readSessionEntryRow(current, resolved.sessionKey);
        const refusal = resolveTranscriptAppendRefusal(fresh?.entry, resolved, fencedScope);
        if (refusal) {
          throw new SessionTranscriptWriterClaimReboundError(refusal);
        }
        const currentVersion = readTranscriptContextVersionInTransaction(
          current,
          resolved.sessionId,
        );
        if (
          currentVersion.generation !== loadedVersion.generation ||
          currentVersion.rawSeq !== loadedVersion.rawSeq ||
          currentVersion.updatedAt !== loadedVersion.updatedAt
        ) {
          throw conflict();
        }
        // The existing append/relocation owners participate in the same transaction.
        // Interruption rolls back entries, key ownership, and receipt publications together.
        for (const entry of entries) {
          assertActive();
          assertOwnedTranscriptWriteCommit(fencedScope);
          if (entry.type === "message") {
            const source = sources.get(entry.id);
            if (!source) {
              throw new Error("Transcript rewrite message has no source entry");
            }
            const result = withSessionPendingInputRelocation(
              source.id,
              entry.message,
              () =>
                appendTranscriptMessageInTransaction(
                  current,
                  resolved,
                  {
                    eventId: entry.id,
                    parentId: entry.parentId,
                    now: Date.parse(entry.timestamp),
                    message: entry.message,
                    messageAlreadyRedacted: true,
                    appendMode: entry.appendMode,
                    idempotencyLookup: "caller-checked",
                  },
                  undefined,
                  preparation,
                )?.result,
            );
            if (!result?.appended || result.messageId !== entry.id) {
              throw new Error("Transcript rewrite message was not appended");
            }
            entry.message = result.message;
          } else if (!appendTranscriptEventInTransaction(current, resolved, entry, preparation)) {
            throw new Error("Transcript rewrite entry was not appended");
          }
        }
        assertActive();
        assertOwnedTranscriptWriteCommit(fencedScope);
        committedVersion = readTranscriptContextVersionInTransaction(current, resolved.sessionId);
        admit?.("commit");
      },
      options,
      { operationLabel: "session.transcript.prepare-rewrite" },
    );
  };
}
