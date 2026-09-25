import type { DatabaseSync } from "node:sqlite";
import type { SessionEntryCacheDatabase } from "./session-accessor.sqlite-entry-cache-projection.js";
import type { SessionEntry } from "./types.js";

export type SessionEntryCacheReadOptions = {
  cache: boolean;
  latest?: boolean;
  projection?: "full" | "list";
  /** Uncached mixed snapshot: retain complete selected rows beside sibling metadata. */
  fullEntryKeys?: readonly string[];
  /** Stream full JSON once, retaining prompt snapshots only for selected rows. Never cached. */
  retainFullEntry?: (sessionKey: string, entry: SessionEntry) => boolean;
  /** Topology admits metadata first; its worker owns participant hydration. Never cache this view. */
  deferParticipants?: true;
};

export type SessionEntryCacheSnapshot = {
  entries: Map<string, SessionEntry>;
  keys: string[];
};

export type SessionSharingEntry = Pick<
  SessionEntry,
  | "sessionId"
  | "updatedAt"
  | "lifecycleRevision"
  | "visibility"
  | "incognito"
  | "createdActor"
  | "sandbox"
>;

export type SessionEntryPlaceholder = Readonly<{ sessionId: string }>;

export type SessionTranscriptInitializationPublication = {
  kind: "session-transcript-initialized";
  sessionKey: string;
  placeholder?: SessionEntryPlaceholder;
};

const creationBrand = Symbol("sessionEntryCreation");
export type SessionEntryCreationOperation = Readonly<{ [creationBrand]: true }>;

/** Allocate an opaque token; the publication owner's WeakMap alone grants live custody. */
export function createSessionEntryCreationOperation(): SessionEntryCreationOperation {
  return Object.freeze({ [creationBrand]: true });
}

export type CommittedSessionSharingFacts = {
  entry: SessionSharingEntry | undefined;
  placeholder?: SessionEntryPlaceholder;
  membership: ReadonlySet<string>;
};
export type SessionEntryPublicationSource = {
  identity: string | symbol;
  birthtime: string | undefined;
  incarnation: string;
  filename: string;
  revision?: number;
};

export type PreparedSessionEntryChanges = {
  source: SessionEntryPublicationSource;
  entries: ReadonlyMap<string, SessionEntry>;
  sharing?: ReadonlyMap<string, SessionSharingEntry>;
};

export type SessionEntryReplacementPublication = {
  kind: "session-entry-replacements";
  previous: Map<string, Pick<SessionEntry, "sessionId" | "lifecycleRevision">>;
  current: Map<string, SessionEntry>;
  source?: SessionEntryPublicationSource;
  changedKeys: string[];
  membershipInvalidatedKeys: string[];
  sharingUnchangedKeys: string[];
};

export type CreationDatabase =
  | {
      kind: "native";
      database: SessionEntryCacheDatabase & { path: string };
      agentId: string | undefined;
    }
  | {
      kind: "file";
      path: string;
      agentId: string;
      databaseIdentity: string;
      assertCurrent: () => void;
    };
export type CreationRecord = {
  agentId: string;
  operation: SessionEntryCreationOperation;
  source: CreationDatabase;
  sessionKey: string;
  active: boolean;
};
export type PlaceholderReceipt = {
  creation: CreationRecord | undefined;
  databaseIdentity: DatabaseSync | string;
  sessionKey: string;
  placeholder: SessionEntryPlaceholder;
  committed: boolean;
};

export type SessionEntryPublicationRecord =
  | { kind: "marker"; sharingChange: "changed" | "unchanged" }
  | {
      kind: "metadata";
      sharingChange: "changed" | "unchanged";
      prepared: PreparedSessionEntryChanges;
    }
  | { kind: "placeholder"; sharingChange: "changed"; receipt: PlaceholderReceipt };

export type PreparedSessionSharingRead = {
  pending: Set<object>;
  facts: CommittedSessionSharingFacts | undefined;
  generation?: {
    current: Pick<SessionEntry, "sessionId" | "lifecycleRevision"> | null | undefined;
  };
};
export type PendingSessionEntryPublication = {
  superseded: Map<string, Pick<SessionEntry, "sessionId" | "lifecycleRevision"> | undefined>;
  metadataSuperseded: Set<string>;
  membershipInvalidated: Set<string>;
  sharingUnchanged: Set<string>;
  settled: boolean;
};

export function readSessionEntryCreationIdentity(creation: CreationRecord): DatabaseSync | string {
  return creation.source.kind === "native"
    ? creation.source.database.db
    : creation.source.databaseIdentity;
}
