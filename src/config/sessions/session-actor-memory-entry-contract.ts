import type {
  DeleteSessionEntryLifecycleResult,
  ResetSessionEntryLifecycleResult,
  SessionResetBoundaryWrite,
} from "./session-accessor.lifecycle-types.js";
import type { SessionEntryPatchOperation } from "./session-entry-patch-operation.js";
import type { SessionOwnerAssignment } from "./session-entry-provenance.js";
import type { SessionEntryProjection } from "./session-entry-snapshot-values.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export type SessionActorMemoryEntryReads = {
  "session.entry.read": {
    input: { projection?: SessionEntryProjection };
    output: SessionEntry | undefined;
  };
  "session.entry.readById": {
    input: { sessionId: string; projection?: SessionEntryProjection };
    output: { sessionKey: string; entry: SessionEntry } | undefined;
  };
  "session.entries.read": {
    input: { projection?: SessionEntryProjection };
    output: Array<{ sessionKey: string; entry: SessionEntry }>;
  };
};

/** Prepared overwrites compare the actual entry; typed patches need no read round trip. */
export type SessionActorMemoryEntryReplacement = {
  sessionKey: string;
  expected: SessionEntry | undefined;
  entry: SessionEntry | undefined;
};

export type SessionActorMemoryEntryWrites = {
  "session.entry.create": {
    input: {
      entry: SessionEntry;
      label?: string;
      owner?: SessionOwnerAssignment;
      cwd?: string;
      transcriptEvents?: readonly unknown[];
    };
    output: SessionEntry;
  };
  "session.entry.patch": {
    input: {
      operation: SessionEntryPatchOperation;
      fallbackEntry?: SessionEntry;
      preserveActivity?: boolean;
    };
    output: SessionEntry | undefined;
  };
  "session.entry.replace": {
    input: Omit<SessionActorMemoryEntryReplacement, "sessionKey">;
    output: SessionEntry | undefined;
  };
  "session.entry.replacements": {
    input: { replacements: readonly SessionActorMemoryEntryReplacement[] };
    output: { removedSessionKeys: string[]; updatedSessionKeys: string[] };
  };
  "session.lifecycle.reset": {
    input: {
      expected: SessionEntry | undefined;
      nextEntry: SessionEntry;
      resetBoundary?: SessionResetBoundaryWrite;
    };
    output: ResetSessionEntryLifecycleResult & { progressCardReset: boolean };
  };
  "session.lifecycle.delete": {
    input: {
      expectedEntry?: SessionEntry;
      expectedSessionId?: string | null;
      expectedLifecycleRevision?: string;
      expectedUpdatedAt?: number;
    };
    output: DeleteSessionEntryLifecycleResult;
  };
  "session.lifecycle.reclaim": {
    input: { entries: readonly { sessionKey: string; expected: SessionEntry }[] };
    output: { removedSessionKeys: string[] };
  };
};

export type SessionActorMemoryEntryQuery = {
  [Key in keyof SessionActorMemoryEntryReads]: {
    type: Key;
    input: SessionActorMemoryEntryReads[Key]["input"];
  };
}[keyof SessionActorMemoryEntryReads];

export type SessionActorMemoryEntryCommand = {
  [Key in keyof SessionActorMemoryEntryWrites]: {
    type: Key;
    input: SessionActorMemoryEntryWrites[Key]["input"];
  };
}[keyof SessionActorMemoryEntryWrites];
