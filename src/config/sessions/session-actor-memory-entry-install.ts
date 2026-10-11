import { createSessionActorMemoryCollaborationState } from "./session-actor-memory-collaboration-state.js";
import {
  selectSessionActorMemoryWindow,
  type SessionActorMemoryState,
} from "./session-actor-memory-state.js";
import {
  hasValidSessionEntryIdentity,
  normalizeSessionEntryTimestamp,
} from "./session-entry-json.js";
import { preserveCreationStamp } from "./session-entry-provenance.js";
import { resolveSessionWindowCreatedAt } from "./session-window-created-at.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

/** Apply logical-node preservation before selecting the actor's transcript window. */
export function installSessionActorMemoryEntry(
  state: SessionActorMemoryState,
  entry: SessionEntry,
  options: { providerReviewMutation?: boolean; consumePendingReset?: boolean } = {},
): SessionEntry {
  const previous = state.hot.entry;
  let next = normalizeSessionEntryTimestamp({ ...entry, incognito: true });
  if (!hasValidSessionEntryIdentity(next)) {
    throw new Error("Refusing invalid memory session entry identity");
  }
  next = preserveCreationStamp(next, previous);
  next.createdAt ??= previous?.updatedAt ?? Date.now();
  const sameWindow = previous?.sessionId === next.sessionId;
  const sameLifecycle = sameWindow && previous?.lifecycleRevision === next.lifecycleRevision;
  if (!options.providerReviewMutation) {
    next.providerReview = sameLifecycle ? previous?.providerReview : undefined;
  }
  if (next.providerReview?.sessionId !== next.sessionId) {
    delete next.providerReview;
  }
  if (!options.consumePendingReset && sameLifecycle && previous?.updatedAt === 0) {
    next.updatedAt = 0;
  }
  if (sameLifecycle && previous?.compactionQualityDegraded) {
    next.compactionQualityDegraded = true;
  }
  const involvement =
    previous?.profileInvolvement ??
    (entry.profileInvolvement?.key === state.hot.target.sessionKey
      ? entry.profileInvolvement
      : undefined);
  if (involvement) {
    next.profileInvolvement = { ...involvement, key: state.hot.target.sessionKey };
  } else {
    delete next.profileInvolvement;
  }
  // A copied transcript never inherits publication or visibility from its old identity.
  delete next.publicShare;
  if (previous && !sameWindow) {
    delete next.visibility;
  }
  selectSessionActorMemoryWindow(state, next);
  state.sourceCreatedAt ??= resolveSessionWindowCreatedAt(next, next.updatedAt);
  if (previous && !sameWindow) {
    state.collaboration = createSessionActorMemoryCollaborationState();
    state.hot.members = [];
    state.hot.participants = [];
    delete state.hot.entry!.participants;
    delete state.hot.entry!.participantCount;
  }
  return state.hot.entry!;
}
