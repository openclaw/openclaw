import { isDeepStrictEqual } from "node:util";
import type { ConversationReadQuery, ConversationRecord } from "./conversation-registry.types.js";
import type { SessionActorMemoryState } from "./session-actor-memory-state.js";
import type {
  SessionSourcePredicate,
  SessionSourceValidation,
} from "./session-source-authority.js";

export function validateSessionActorMemorySources(
  get: (sessionKey: string) => SessionActorMemoryState | undefined,
  incarnation: string,
  sources: SessionSourcePredicate[] | undefined,
  readConversations: (query: ConversationReadQuery) => ConversationRecord[],
): SessionSourceValidation {
  const result: SessionSourceValidation = { conversationMatches: [] };
  for (const [index, source] of (sources ?? []).entries()) {
    const other = get(source.sessionKey);
    const entry = other?.hot.entry;
    const members = source.members && other?.hot.members.map((member) => member.identityId);
    if (
      source.source.databaseIdentity !== incarnation ||
      Boolean(entry) !== Boolean(source.expected) ||
      source.fields.some((field) => !isDeepStrictEqual(entry?.[field], source.expected?.[field])) ||
      (source.members && !isDeepStrictEqual(members, source.members)) ||
      (source.transcript &&
        (source.transcript.sessionId !== entry?.sessionId ||
          !isDeepStrictEqual(source.transcript.version, other?.hot.transcript.version)))
    ) {
      return { ...result, refusedSource: { index, facts: { entry, members } } };
    }
    if (source.conversationAlternatives?.length) {
      const rows = readConversations({
        conversationRefs: [
          ...new Set(
            source.conversationAlternatives.flatMap((alternative) =>
              alternative.map((predicate) => predicate.conversationRef),
            ),
          ),
        ],
        currentBindingOnly: true,
      });
      const bindings = new Map(rows.map((row) => [row.conversationRef, row.sessionKey ?? null]));
      const alternatives = source.conversationAlternatives.flatMap(
        (alternative, alternativeIndex) =>
          alternative.every(
            (predicate) =>
              (bindings.get(predicate.conversationRef) ?? null) === predicate.sessionKey,
          )
            ? [alternativeIndex]
            : [],
      );
      if (!alternatives.length) {
        return { ...result, refusedSource: { index, facts: { entry, members } } };
      }
      result.conversationMatches.push({ index, alternatives });
    }
  }
  return result;
}
