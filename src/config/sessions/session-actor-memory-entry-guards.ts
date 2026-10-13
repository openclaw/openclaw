import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { CLI_HISTORY_CHANGED_BEFORE_PREPARATION } from "./cli-history-boundary.js";
import { assertConversationAuthority } from "./conversation-authority.js";
import { selectSessionActorMemoryConversations } from "./session-actor-memory-conversation.js";
import type { SessionActorMemoryEntryWrites } from "./session-actor-memory-entry-contract.js";
import { selectSessionActorMemoryAdmittedWindow } from "./session-actor-memory-history-context.js";
import { createSessionActorMemoryHistoryNavigation } from "./session-actor-memory-history-navigation.js";
import { resolveSessionActorMemoryWindow } from "./session-actor-memory-state.js";
import type { SessionActorMemoryStorageContext } from "./session-actor-memory-storage-context.js";

/** Prepared external effects retain their source and exact transcript predicates. */
export function validateSessionActorMemoryEntryGuards(
  context: SessionActorMemoryStorageContext,
  guards: SessionActorMemoryEntryWrites["session.entry.patch"]["input"]["guards"],
): boolean {
  if (!guards) {
    return true;
  }
  if (guards.conversation) {
    assertConversationAuthority(
      selectSessionActorMemoryConversations(context, {
        conversationRef: guards.conversation.conversationRef,
        limit: 1,
      })[0],
      guards.conversation,
    );
  }
  if (guards.sources?.length) {
    const validation = context.validateSources(guards.sources);
    context.admit("commit", { kind: "session.entry.sources", validation });
    if (validation.refusedSource) {
      throw new Error("Session source changed before entry mutation");
    }
  }
  const cli = guards.cliHistory;
  if (cli) {
    const window = resolveSessionActorMemoryWindow(context.state, cli.sessionId);
    if (!window || !isDeepStrictEqual(window.hot.transcript.watermark, cli.watermark)) {
      throw new Error(CLI_HISTORY_CHANGED_BEFORE_PREPARATION);
    }
    selectSessionActorMemoryAdmittedWindow(window, context, cli.admission);
  }
  const predicate = guards.shouldCommitIf;
  if (!predicate) {
    return true;
  }
  const window = resolveSessionActorMemoryWindow(context.state, predicate.sessionId);
  if (!window || window.hot.transcript.version.generation !== predicate.generation) {
    return false;
  }
  return (
    !predicate.leafEntryId ||
    createSessionActorMemoryHistoryNavigation(window).active.some(
      ({ event }) => isRecord(event) && event.id === predicate.leafEntryId,
    )
  );
}
