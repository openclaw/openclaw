import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.types.js";
import type { SqliteLifecycleTargetSnapshot } from "./session-accessor.sqlite-entry-equality.js";
import type { SessionActorHotState, SessionActorVersion } from "./session-actor-state.types.js";
import { readSessionActorTransactionState } from "./session-actor-transaction.js";
import type {
  SessionEntryPatchCommitted,
  SessionEntryPatchGuard,
} from "./session-entry-patch.types.js";
import type { SessionEntryWritePostimages } from "./session-entry-write-postimage.js";
import type { SessionParticipantRecord } from "./session-membership-facts.types.js";

type PrepareEntryPatch = (
  database: OpenClawAgentDatabase,
  sessionKey: string,
) =>
  | {
      snapshot(): SqliteLifecycleTargetSnapshot[number];
      readPredicate: (predicate: SessionEntryPatchGuard["shouldCommitIf"]) => {
        matches: boolean;
        transcriptPredicate?: SessionEntryPatchCommitted["transcriptPredicate"];
      };
      publish(
        postimages: SessionEntryWritePostimages,
        publication: SessionEntryReplacementPublication,
      ): void;
    }
  | undefined;

const owners = new WeakMap<OpenClawAgentDatabase["db"], PrepareEntryPatch>();
type ParticipantDatabase = Pick<OpenClawAgentDatabase, "db">;
type ParticipantOwner = {
  read: (
    database: ParticipantDatabase,
    sessionKey: string,
  ) => Pick<SessionActorHotState, "entry" | "participants"> | undefined;
  prepare: (
    database: ParticipantDatabase,
    sessionKey: string,
    singleStatement?: boolean,
  ) =>
    | {
        version: SessionActorVersion;
        publish(participants: SessionParticipantRecord[]): void;
      }
    | undefined;
};
const participantOwners = new WeakMap<OpenClawAgentDatabase["db"], ParticipantOwner>();

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
      : participantOwners.get(database.db)?.read(database, sessionKey)?.participants;
  return participants && structuredClone([...participants]);
}

/** Non-mutating read paired with the resident aggregate used by the count-only fast path. */
export function readSessionActorParticipantDisplay(
  database: ParticipantDatabase,
  sessionKey: string,
) {
  const transaction = readSessionActorTransactionState(database, { sessionKey });
  return transaction?.hot.target.sessionKey === sessionKey
    ? transaction.hot.entry?.participantDisplay
    : participantOwners.get(database.db)?.read(database, sessionKey)?.entry?.participantDisplay;
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
