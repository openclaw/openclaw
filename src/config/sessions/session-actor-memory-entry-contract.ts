import type { ConversationRouteContext } from "./conversation-route-context.js";
import type {
  DeleteSessionEntryLifecycleResult,
  ResetSessionEntryLifecycleResult,
  SessionResetBoundaryWrite,
  SessionLifecycleArtifactCleanupParams,
} from "./session-accessor.lifecycle-types.js";
import type { SessionEntryCreateWithTranscriptContext } from "./session-accessor.types.js";
import type { SessionEntryPatchOperation } from "./session-entry-patch-operation.js";
import type { SessionEntryPatchCommit } from "./session-entry-patch.types.js";
import type { SessionOwnerAssignment } from "./session-entry-provenance.js";
import type { SessionEntryProjection } from "./session-entry-snapshot-values.js";
import type { SessionMaintenancePreservationSnapshot } from "./store-maintenance-preserve-snapshot.types.js";
import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export type MemoryLifecycleArtifactInput = Pick<
  SessionLifecycleArtifactCleanupParams,
  | "sessionKeySegmentPrefix"
  | "transcriptContentMarker"
  | "orphanTranscriptMinAgeMs"
  | "pluginOwnerId"
> & { nowMs: number };
export type MemoryLifecycleArtifactPlan = {
  entries: Array<{ sessionKey: string; expected: SessionEntry }>;
  windows: Array<{ sessionKey: string; sessionId: string }>;
};

export type SessionActorMemoryEntryReads = {
  "session.lifecycle.artifacts": {
    input: MemoryLifecycleArtifactInput;
    output: MemoryLifecycleArtifactPlan;
  };
  "session.entry.creation": {
    input: { label?: string };
    output: SessionEntryCreateWithTranscriptContext;
  };
  "session.entry.read": {
    input: { sessionKey?: string; projection?: SessionEntryProjection };
    output: SessionEntry | undefined;
  };
  "session.entry.readById": {
    input: { sessionId: string; projection?: SessionEntryProjection; currentOnly?: boolean };
    output: { sessionKey: string; entry: SessionEntry } | undefined;
  };
  "session.entries.read": {
    input: {
      projection?: SessionEntryProjection;
      sessionKeys?: readonly string[];
      includeSessionWindowOwner?: string;
      includeLabelOwners?: string;
    };
    output: Array<{ sessionKey: string; entry: SessionEntry }>;
  };
};

/** Prepared overwrites compare the actual entry; typed patches need no read round trip. */
type SessionActorMemoryEntryReplacement = {
  sessionKey: string;
  expected: SessionEntry | undefined;
  entry: SessionEntry | undefined;
  routeContext?: ConversationRouteContext | null;
  label?: string;
  owner?: SessionOwnerAssignment;
  transcriptEvents?: readonly unknown[];
};

export type SessionActorMemoryMaintenance = {
  config: ResolvedSessionMaintenanceConfig;
  preservation: SessionMaintenancePreservationSnapshot;
  activeSessionKey?: string;
};

export type SessionActorMemoryEntryWrites = {
  "session.entry.create": {
    input: {
      entry: SessionEntry;
      routeContext?: ConversationRouteContext | null;
      expected?: SessionEntry;
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
      maintenance?: SessionActorMemoryMaintenance;
      fallbackEntry?: SessionEntry;
      preserveActivity?: boolean;
      replaceEntry?: boolean;
      providerReviewMutation?: boolean;
      consumePendingReset?: boolean;
      prepareIf?: { kind: "live-model-switch-pending" };
      expected?: { entry: SessionEntry | undefined };
      guards?: Pick<
        SessionEntryPatchCommit,
        "shouldCommitIf" | "cliHistory" | "conversation" | "sources"
      >;
    };
    output: SessionEntry | undefined;
  };
  "session.entry.replace": {
    input: Omit<SessionActorMemoryEntryReplacement, "sessionKey">;
    output: SessionEntry | undefined;
  };
  "session.entry.replacements": {
    input: {
      replacements: readonly SessionActorMemoryEntryReplacement[];
      consumePendingReset?: boolean;
      maintenance?: SessionActorMemoryMaintenance;
    };
    output: { removedSessionKeys: string[]; updatedSessionKeys: string[] };
  };
  "session.lifecycle.reset": {
    input: {
      expected: SessionEntry | undefined;
      nextEntry: SessionEntry;
      routeContext?: ConversationRouteContext | null;
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
    input: {
      entries: readonly { sessionKey: string; expected: SessionEntry }[];
      artifacts?: {
        input: MemoryLifecycleArtifactInput;
        windows: MemoryLifecycleArtifactPlan["windows"];
      };
    };
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
