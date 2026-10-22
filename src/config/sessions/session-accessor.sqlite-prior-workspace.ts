import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readSessionKeyBySessionIdInDatabase } from "./session-accessor.sqlite-entry-read.js";
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { readTranscriptGenerationInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { readSessionActorTransactionState } from "./session-actor-transaction.js";
import {
  rewriteSessionPriorWorkspaceBoundary,
  type PriorWorkspaceRewriteRows,
} from "./session-prior-workspace-boundary.js";

/** The existing actor/entry owner supplies the relation inside the rewrite transaction. */
export function preparePriorWorkspaceRewriteInTransaction(
  database: OpenClawAgentDatabase,
  scope: { sessionId: string; sessionKey?: string },
) {
  const actor = readSessionActorTransactionState(database, scope);
  const sessionKey =
    scope.sessionKey ??
    actor?.hot.target.sessionKey ??
    readSessionKeyBySessionIdInDatabase(database, scope.sessionId);
  const entry = actor
    ? actor.hot.entry
    : sessionKey
      ? readExactSessionEntryRow(database, sessionKey)?.entry
      : undefined;
  if (
    !sessionKey ||
    !entry?.priorWorkspace ||
    entry.sessionId !== scope.sessionId ||
    entry.priorWorkspace.sessionId !== scope.sessionId ||
    entry.priorWorkspace.worktreeId !== entry.worktree?.id
  ) {
    return undefined;
  }
  const previousGeneration =
    readTranscriptGenerationInTransaction(database, scope.sessionId) ?? null;
  return {
    commit(generation: string | null, rows?: PriorWorkspaceRewriteRows) {
      const next = rewriteSessionPriorWorkspaceBoundary(
        entry,
        previousGeneration,
        generation,
        rows,
      );
      if (next !== entry) {
        writeSessionEntry(database, sessionKey, next, { previousEntry: entry });
      }
    },
  };
}
