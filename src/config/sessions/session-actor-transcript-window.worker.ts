import type { SessionActorStoredState } from "./session-actor-hydration.types.js";
import {
  writableSessionActorMap,
  writableSessionActorNavigation,
} from "./session-actor-transaction.js";

export const SESSION_ACTOR_TRANSCRIPT_WINDOW = 512;

function retainTail<K, V>(rows: Map<K, V>): Map<K, V> {
  if (rows.size <= SESSION_ACTOR_TRANSCRIPT_WINDOW) {
    return rows;
  }
  const retained = writableSessionActorMap(rows);
  for (const key of retained.keys()) {
    if (retained.size <= SESSION_ACTOR_TRANSCRIPT_WINDOW) {
      break;
    }
    retained.delete(key);
  }
  return retained;
}

/** Receipts own appended bodies; older navigation and identities remain in their SQL indexes. */
export function retainSessionActorTranscriptWindow(state: SessionActorStoredState): void {
  const transcript = state.transcript;
  if (
    Math.max(transcript.navigation.length, transcript.identities.size, transcript.active.size) <=
    SESSION_ACTOR_TRANSCRIPT_WINDOW
  ) {
    return;
  }
  transcript.complete = false;
  transcript.contextMetadata = undefined;
  // Appends already detached their changed collections; keep that private storage.
  if (transcript.navigation.length > SESSION_ACTOR_TRANSCRIPT_WINDOW) {
    transcript.navigation = writableSessionActorNavigation(transcript.navigation);
    transcript.navigation.splice(0, transcript.navigation.length - SESSION_ACTOR_TRANSCRIPT_WINDOW);
  }
  transcript.identities = retainTail(transcript.identities);
  transcript.active = retainTail(transcript.active);
}
