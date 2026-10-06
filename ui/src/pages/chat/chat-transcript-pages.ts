import { readChatThreadMessageIdentity } from "./chat-thread-items.ts";

function transcriptEntryKey(message: unknown): string | undefined {
  const identity = readChatThreadMessageIdentity(message);
  if (!identity) {
    return undefined;
  }
  return identity.externalSource
    ? `external:${identity.externalSource}`
    : identity.id
      ? `id:${identity.id}`
      : identity.sequence == null
        ? undefined
        : `seq:${identity.sequence}`;
}

export function mergeChatTranscriptPages(earlier: unknown[], later: unknown[]) {
  const laterKeys = new Set(later.map(transcriptEntryKey).filter(Boolean));
  const overlap = earlier.findIndex((message) => {
    const key = transcriptEntryKey(message);
    return key !== undefined && laterKeys.has(key);
  });
  return {
    // The newer page owns whole overlapping entries, including projected siblings.
    messages: [...earlier.slice(0, overlap < 0 ? earlier.length : overlap), ...later],
    hasOverlap: overlap >= 0,
  };
}
