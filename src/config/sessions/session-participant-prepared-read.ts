import type { DatabaseSync } from "node:sqlite";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { findOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { SessionParticipantProjection } from "./session-membership-facts.types.js";

type ParticipantRead = (
  identity: string | symbol,
  sessionKey: string,
) => SessionParticipantProjection | undefined;
let preparedRead: ParticipantRead | undefined;

/** Only synchronous materialization borrows facts; transaction authority always reads its owner. */
export function withPreparedSessionParticipants<T>(read: ParticipantRead, consume: () => T): T {
  const previous = preparedRead;
  preparedRead = read;
  try {
    const value = consume();
    if (isPromiseLike(value)) {
      void Promise.resolve(value).catch(() => {});
      throw new Error("Prepared participant consumers must remain synchronous");
    }
    return value;
  } finally {
    preparedRead = previous;
  }
}

export function readPreparedSessionParticipants(
  database: DatabaseSync,
  sessionKey: string,
): SessionParticipantProjection | undefined {
  if (!preparedRead || database.isTransaction) {
    return undefined;
  }
  const identity = findOpenClawAgentDatabaseIdentity({ db: database })?.identity;
  if (identity === undefined) {
    return undefined;
  }
  const projection = preparedRead(identity, sessionKey);
  return (
    projection && {
      ...(projection.participants
        ? {
            participants: projection.participants.map(({ identity: participantIdentity }) => ({
              identity: { ...participantIdentity },
            })),
          }
        : {}),
      ...(projection.participantCount === undefined
        ? {}
        : { participantCount: projection.participantCount }),
    }
  );
}
