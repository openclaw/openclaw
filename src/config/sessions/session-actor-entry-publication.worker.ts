import type { DatabaseSync } from "node:sqlite";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.types.js";
import type { SqliteLifecycleTargetSnapshot } from "./session-accessor.sqlite-entry-equality.js";
import { readSessionActorTransactionState } from "./session-actor-transaction.js";
import type { SessionEntryWritePostimages } from "./session-entry-write-postimage.js";
import type { SessionParticipantRecord } from "./session-membership-facts.types.js";
import type { SessionTranscriptWatermark } from "./session-transcript-context-version.types.js";

type PrepareEntryPatch = (
  database: OpenClawAgentDatabase,
  sessionKey: string,
) =>
  | {
      snapshot(): SqliteLifecycleTargetSnapshot[number];
      transcript: { sessionId: string; watermark: SessionTranscriptWatermark };
      publish(
        postimages: SessionEntryWritePostimages,
        publication: SessionEntryReplacementPublication,
      ): void;
    }
  | undefined;

const owners = new WeakMap<DatabaseSync, PrepareEntryPatch>();
type ParticipantDatabase = Pick<OpenClawAgentDatabase, "db">;
type ParticipantOwner = {
  read: (
    database: ParticipantDatabase,
    sessionKey: string,
  ) => readonly SessionParticipantRecord[] | undefined;
  prepare: (
    database: ParticipantDatabase,
    sessionKey: string,
    singleStatement?: boolean,
  ) => ((participants: SessionParticipantRecord[]) => void) | undefined;
};
const participantOwners = new WeakMap<DatabaseSync, ParticipantOwner>();

export function registerSessionActorParticipantOwner(
  database: ParticipantDatabase,
  owner: ParticipantOwner,
): void {
  participantOwners.set(database.db, owner);
}

/** Transaction-local writes take precedence over the resident committed preimage. */
export function readSessionActorParticipants(
  database: ParticipantDatabase,
  sessionKey: string,
): SessionParticipantRecord[] | undefined {
  const transaction = readSessionActorTransactionState(database, { sessionKey });
  const participants =
    transaction?.hot.target.sessionKey === sessionKey
      ? transaction.hot.participants
      : participantOwners.get(database.db)?.read(database, sessionKey);
  return participants && structuredClone([...participants]);
}

export function prepareSessionActorParticipantUpdate(
  database: ParticipantDatabase,
  sessionKey: string,
  singleStatement = false,
) {
  return participantOwners.get(database.db)?.prepare(database, sessionKey, singleStatement);
}

export function registerSessionActorEntryPatchOwner(
  database: OpenClawAgentDatabase,
  prepare: PrepareEntryPatch,
): void {
  owners.set(database.db, prepare);
}

/** Only a resident actor can retain the pending and transcript facts untouched by an entry patch. */
export function prepareSessionActorEntryPatch(database: OpenClawAgentDatabase, sessionKey: string) {
  return owners.get(database.db)?.(database, sessionKey);
}
