import type { SessionActorStoredState } from "./session-actor-hydration.types.js";
import { writableSessionActorMap } from "./session-actor-transaction.js";
import type { SessionParticipantRecord } from "./session-membership-facts.types.js";
import { participantIdentityNamespace } from "./session-participant-identity.js";

export function replaceSessionActorParticipants(
  working: SessionActorStoredState,
  participants: SessionParticipantRecord[],
) {
  working.hot.participants = structuredClone(participants).toSorted(
    (left, right) =>
      (left.firstPromptedAt === right.firstPromptedAt
        ? 0
        : left.firstPromptedAt === null
          ? -1
          : right.firstPromptedAt === null
            ? 1
            : left.firstPromptedAt - right.firstPromptedAt) ||
      Buffer.compare(Buffer.from(left.identity.id), Buffer.from(right.identity.id)) ||
      Buffer.compare(
        Buffer.from(participantIdentityNamespace(left.identity)),
        Buffer.from(participantIdentityNamespace(right.identity)),
      ),
  );
  const sessionKey = working.hot.target.sessionKey;
  const selected = working.entryRows.get(sessionKey);
  if (working.hot.entry && selected) {
    const entry = { ...working.hot.entry };
    delete entry.participants;
    delete entry.participantCount;
    if (working.hot.participants.length) {
      entry.participants = working.hot.participants.map(({ identity }) => ({
        identity: { ...identity },
      }));
      entry.participantCount = working.hot.participants.length;
    }
    working.entryRows = writableSessionActorMap(working.entryRows);
    working.entryRows.set(sessionKey, { ...selected, entry });
    working.hot.entry = entry;
  }
}
