import { isDeepStrictEqual } from "node:util";
import type { SessionActorMemoryState } from "./session-actor-memory-state.js";
import type {
  SessionSourcePredicate,
  SessionSourceValidation,
} from "./session-source-authority.js";

export function validateSessionActorMemorySources(
  get: (sessionKey: string) => SessionActorMemoryState | undefined,
  incarnation: string,
  sources?: SessionSourcePredicate[],
): SessionSourceValidation {
  const result: SessionSourceValidation = { conversationMatches: [] };
  for (const [index, source] of (sources ?? []).entries()) {
    const other = get(source.sessionKey);
    const entry = other?.hot.entry;
    const members = source.members && other?.hot.members.map((member) => member.identityId);
    if (source.conversationAlternatives?.length) {
      throw new Error("Memory session conversation bindings are not installed");
    }
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
  }
  return result;
}
