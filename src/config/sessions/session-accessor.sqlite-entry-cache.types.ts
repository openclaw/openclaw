import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { SessionRowFacts } from "../../sessions/session-row-changes.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { InternalSessionEntry, SessionEntry } from "./types.js";

export type SessionEntryCacheDatabase = Pick<OpenClawAgentDatabase, "agentId" | "db">;

export type SessionEntryCacheReadOptions = {
  cache: boolean;
  latest?: boolean;
  projection?: "full" | "list";
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
  | "createdAt"
  | "initializationPending"
  | "providerReview"
  | "mainRestartRecovery"
  | "modelSelectionLocked"
  | "pendingProjectGitUrl"
  | "pendingWorktree"
  | "lifecycleRevision"
  | "lifecycleRunId"
  | "activeWriterRunId"
  | "subagentRecovery"
  | "archivedAt"
  | "repositoryWorkspaceId"
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
    createdAt: entry.createdAt,
    initializationPending: entry.initializationPending,
    providerReview: entry.providerReview ? structuredClone(entry.providerReview) : undefined,
    mainRestartRecovery: entry.mainRestartRecovery
      ? structuredClone(entry.mainRestartRecovery)
      : undefined,
    modelSelectionLocked: entry.modelSelectionLocked,
    pendingProjectGitUrl: entry.pendingProjectGitUrl,
    pendingWorktree: entry.pendingWorktree ? structuredClone(entry.pendingWorktree) : undefined,
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
    ...(entry.repositoryWorkspaceId === undefined
      ? {}
      : { repositoryWorkspaceId: entry.repositoryWorkspaceId }),
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

/** Timestamp-only progress does not change retained sharing authority. */
export function sessionSharingEntriesEqual(
  previous: InternalSessionEntry | undefined,
  current: InternalSessionEntry | undefined,
): boolean {
  if (!previous || !current) {
    return false;
  }
  const { updatedAt: _previousUpdatedAt, ...before } = projectSessionSharingEntry(previous);
  const { updatedAt: _currentUpdatedAt, ...after } = projectSessionSharingEntry(current);
  return isDeepStrictEqual(before, after);
}

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
  pendingArchiveRecovery: boolean;
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

export type PendingSessionEntryPublication = {
  superseded: Map<string, Pick<SessionEntry, "sessionId" | "lifecycleRevision"> | undefined>;
  metadataSuperseded: Set<string>;
  ownerChanges: Map<string, Extract<SessionRowFacts, { kind: "owner" }>>;
  membershipInvalidated: Set<string>;
  sharingUnchanged: Set<string>;
  settled: boolean;
};

export function readSessionEntryCreationIdentity(creation: CreationRecord): DatabaseSync | string {
  return creation.source.kind === "native"
    ? creation.source.database.db
    : creation.source.databaseIdentity;
}
