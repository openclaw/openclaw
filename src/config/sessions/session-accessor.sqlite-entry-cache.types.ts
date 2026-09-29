import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { InternalSessionEntry, SessionEntry } from "./types.js";

export type SessionEntryCacheDatabase = Pick<OpenClawAgentDatabase, "agentId" | "db">;

export type SessionEntryCacheReadOptions = {
  cache: boolean;
  latest?: boolean;
  projection?: "full" | "list";
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
  InternalSessionEntry,
  | "sessionId"
  | "updatedAt"
  | "lifecycleRevision"
  | "lifecycleRunId"
  | "activeWriterRunId"
  | "subagentRecovery"
  | "archivedAt"
  | "visibility"
  | "incognito"
  | "createdActor"
  | "owner"
  | "sandbox"
  | "spawnedBy"
  | "spawnDepth"
  | "parentSessionKey"
  | "sessionStartedAt"
>;

export function projectSessionSharingEntry(entry: InternalSessionEntry): SessionSharingEntry {
  return {
    sessionId: entry.sessionId,
    updatedAt: entry.updatedAt,
    lifecycleRevision: entry.lifecycleRevision,
    lifecycleRunId: entry.lifecycleRunId,
    activeWriterRunId: entry.activeWriterRunId,
    ...(entry.subagentRecovery
      ? {
          subagentRecovery: {
            lastRunId: entry.subagentRecovery.lastRunId,
            sessionLifecycleRunId: entry.subagentRecovery.sessionLifecycleRunId,
          },
        }
      : {}),
    archivedAt: entry.archivedAt,
    visibility: entry.visibility,
    incognito: entry.incognito,
    createdActor: entry.createdActor ? { ...entry.createdActor } : undefined,
    owner: entry.owner
      ? {
          ...entry.owner,
          actor: { ...entry.owner.actor },
          assignedBy: entry.owner.assignedBy ? { ...entry.owner.assignedBy } : undefined,
        }
      : undefined,
    sandbox: entry.sandbox,
    spawnedBy: entry.spawnedBy,
    spawnDepth: entry.spawnDepth,
    parentSessionKey: entry.parentSessionKey,
    sessionStartedAt: entry.sessionStartedAt,
  };
}

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
