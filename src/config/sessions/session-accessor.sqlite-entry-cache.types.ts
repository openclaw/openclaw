import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { SessionEntryMaintenanceAgeChange } from "./session-accessor.sqlite-maintenance-age.js";
import type { SessionActorHotState } from "./session-actor-state.types.js";
import type { SessionMembershipFact } from "./session-membership-facts.types.js";
import type { SessionTranscriptWatermark } from "./session-transcript-context-version.types.js";
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
  keyof ReturnType<typeof projectSessionSharingEntry>
>;

export function projectSessionSharingEntry(entry: InternalSessionEntry) {
  return {
    sessionId: entry.sessionId,
    previousSessionId: entry.previousSessionId,
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
    category: entry.category,
    sidebarRoot: entry.sidebarRoot,
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
    permissionMode: entry.permissionMode,
    toolOverrides: entry.toolOverrides ? structuredClone(entry.toolOverrides) : undefined,
  };
}

export type SessionEntryPlaceholder = Readonly<{ sessionId: string }>;

export type SessionTranscriptInitializationPublication = {
  kind: "session-transcript-initialized";
  transcriptPublication?: readonly import("./session-transcript-authority.js").SessionTranscriptAuthorityReceipt[];
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
  canonicalPath?: string;
  revision?: number;
  /** Complete postimages may be reused only at this committing writer's physical revision. */
  writeToken?: string;
};

export type PreparedSessionEntryChanges = {
  source: SessionEntryPublicationSource;
  entries: ReadonlyMap<string, SessionEntry>;
  fullEntries?: ReadonlyMap<string, SessionEntry>;
  actorPostimages?: ReadonlyMap<string, SessionActorHotState>;
  sharing?: ReadonlyMap<string, SessionSharingEntry>;
  projection?: ReadonlyMap<string, SessionEntryProjectionFacts>;
};

export type SessionEntryProjectionFacts = {
  membership: SessionMembershipFact;
  hasBoard: boolean;
  activitySummaryWatermark: SessionTranscriptWatermark | undefined;
};

export type SessionEntryReplacementPublication = {
  kind: "session-entry-replacements";
  transcriptPublication?: readonly import("./session-transcript-authority.js").SessionTranscriptAuthorityReceipt[];
  pendingArchiveRecovery: boolean;
  previous: Map<string, Pick<SessionEntry, "sessionId" | "lifecycleRevision">>;
  current: Map<string, SessionEntry>;
  /** Full snapshots belong to bounded entry readers, not resident display rows. */
  fullEntries?: ReadonlyMap<string, SessionEntry>;
  /** Closed entry patches preserve the resident actor's unchanged custody and transcript facts. */
  actorPostimages?: ReadonlyMap<string, SessionActorHotState>;
  /** Canonical metadata is committed, but these entries lack a valid display projection. */
  unavailableParticipantKeys?: readonly string[];
  ageChanges: SessionEntryMaintenanceAgeChange[];
  source?: SessionEntryPublicationSource;
  projection?: ReadonlyMap<string, SessionEntryProjectionFacts>;
  changedKeys: string[];
  membershipInvalidatedKeys: string[];
  sharingUnchangedKeys: string[];
  generationUnchangedKeys: string[];
};

export type CreationDatabase =
  | {
      kind: "native";
      database: SessionEntryCacheDatabase & { path: string };
      agentId: string | undefined;
    }
  | {
      kind: "file" | "actor";
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
  kind: "placeholder";
  creation: CreationRecord | undefined;
  databaseIdentity: DatabaseSync | string;
  sessionKey: string;
  placeholder: SessionEntryPlaceholder;
  committed: boolean;
};

export type CreatedSessionEntryReceipt = {
  kind: "entry";
  creation: CreationRecord;
  databaseIdentity: string;
  sessionKey: string;
  entry: SessionSharingEntry;
  committed: true;
};

export type SessionEntryPublicationRecord = {
  databaseIdentity?: string | symbol;
  canonicalPath?: string;
} & (
  | { kind: "source" }
  | { kind: "marker"; sharingChange: "changed" | "unchanged" }
  | {
      kind: "metadata";
      sharingChange: "changed" | "unchanged";
      previous?: Pick<SessionEntry, "sessionId" | "lifecycleRevision">;
      prepared: PreparedSessionEntryChanges;
      /** Row delivery rechecks and folds synchronous writes made by earlier listeners. */
      readCurrent?: (sessionKey: string) =>
        | {
            entry?: SessionEntry;
            fullEntry?: SessionEntry;
            actorPostimage?: SessionActorHotState;
            sharing?: SessionSharingEntry;
            projection?: SessionEntryProjectionFacts;
          }
        | undefined;
      creation?: CreatedSessionEntryReceipt;
    }
  | { kind: "placeholder"; sharingChange: "changed"; receipt: PlaceholderReceipt }
);

export type PendingSessionEntryPublication = {
  superseded: Set<string>;
  membershipInvalidated: Set<string>;
  sharingUnchanged: Set<string>;
  /** Keys whose committed sessionId and lifecycleRevision are unchanged by this publication. */
  generationUnchanged: Set<string>;
  settled: boolean;
  completion: Promise<void>;
};

export function readSessionEntryCreationIdentity(creation: CreationRecord): DatabaseSync | string {
  return creation.source.kind === "native"
    ? creation.source.database.db
    : creation.source.databaseIdentity;
}

export function assertSessionEntryCreationCurrent(
  creation: CreationRecord | undefined,
): asserts creation is CreationRecord {
  if (!creation?.active) {
    throw new Error("Session creation publication owner is no longer current");
  }
  const source = creation.source;
  if (source.kind !== "native") {
    source.assertCurrent();
  } else if (!source.database.db.isOpen || source.database.agentId !== source.agentId) {
    throw new Error("Session creation publication owner is no longer current");
  }
}

export type SessionEntryCreationTarget = {
  agentId: string;
  sessionKey: string;
  paths: ReadonlySet<string>;
  databaseIdentity?: string;
};

export function assertSessionEntryCreationTarget(
  creation: CreationRecord | undefined,
  target: SessionEntryCreationTarget,
): void {
  assertSessionEntryCreationCurrent(creation);
  const sourcePath =
    creation.source.kind === "native" ? creation.source.database.path : creation.source.path;
  const matchesDatabaseIdentity =
    creation.source.kind !== "native" &&
    target.databaseIdentity ===
      (creation.source.kind === "actor"
        ? creation.source.databaseIdentity
        : `file:${creation.source.databaseIdentity}`);
  const matchesTarget =
    target.databaseIdentity !== undefined
      ? matchesDatabaseIdentity
      : target.paths.has(path.resolve(sourcePath));
  if (
    creation.agentId !== target.agentId ||
    creation.sessionKey !== target.sessionKey ||
    !matchesTarget
  ) {
    throw new Error("Session creation publication owner is no longer current");
  }
}
