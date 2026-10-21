import type { SessionActorStoredState } from "./session-actor-hydration.types.js";

export const SESSION_ACTOR_TRANSCRIPT_WINDOW = 512;

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
  transcript.navigation = transcript.navigation.slice(-SESSION_ACTOR_TRANSCRIPT_WINDOW);
  transcript.identities = new Map(
    [...transcript.identities].slice(-SESSION_ACTOR_TRANSCRIPT_WINDOW),
  );
  transcript.active = new Map([...transcript.active].slice(-SESSION_ACTOR_TRANSCRIPT_WINDOW));
}
