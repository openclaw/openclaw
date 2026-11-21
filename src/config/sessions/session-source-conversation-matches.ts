import type { SessionSourcePredicate } from "./session-source-authority.js";

export function createSessionSourceConversationMatches(sources: readonly SessionSourcePredicate[]) {
  return sources.flatMap((source, index) =>
    source.conversationAlternatives
      ? [
          {
            index,
            matches: new Int32Array(
              new SharedArrayBuffer(
                (source.conversationAlternatives.length + 1) * Int32Array.BYTES_PER_ELEMENT,
              ),
            ),
          },
        ]
      : [],
  );
}
