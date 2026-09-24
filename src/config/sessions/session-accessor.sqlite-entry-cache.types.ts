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
