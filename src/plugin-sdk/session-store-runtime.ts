import path from "node:path";
import {
  readAmbientTranscriptWatermarkFromEntry,
  resolveAmbientTranscriptWatermarkKey,
  updateAmbientTranscriptWatermark,
  type AmbientTranscriptWatermarkScope,
} from "../config/sessions/ambient-transcript-watermark.js";
import { buildConversationIdentity } from "../config/sessions/conversation-identity.js";
import { resolveCurrentConversationSession } from "../config/sessions/conversation-registry.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  cleanupSessionLifecycleArtifactsCore as cleanupAccessorSessionLifecycleArtifacts,
  deleteSessionEntryLifecycle as deleteAccessorSessionEntryLifecycle,
  loadTranscriptEventsSync as loadAccessorTranscriptEventsSync,
  listSessionEntriesCore as listAccessorSessionEntries,
  listSessionEntriesReadOnly as listAccessorSessionEntriesReadOnly,
  loadSessionEntryReadOnly,
  patchSessionEntryCore as patchAccessorSessionEntry,
  readSessionUpdatedAtCore as readAccessorSessionUpdatedAt,
  readTranscriptStatsSync as readAccessorTranscriptStatsSync,
  updateSessionEntry,
} from "../config/sessions/session-accessor.js";
import { readSessionUpdatedAtInWorker } from "../config/sessions/session-entry-read-runtime.js";
import {
  captureExternalSessionCommitGuard,
  sessionEntryCommitGuardOptions,
} from "../config/sessions/session-source-authority.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { normalizeResolvedMaintenanceConfigInput } from "../config/sessions/store-maintenance.js";
import type { ResolvedSessionMaintenanceConfigInput } from "../config/sessions/store-maintenance.js";
import type {
  AmbientTranscriptWatermark,
  InternalSessionEntry,
  SessionEntry,
} from "../config/sessions/types.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import {
  clearGenerationPrivateFieldsForRotatedSessionPatch,
  generationValidPrivateFieldsForSameSession,
  projectPluginSessionEntry,
  projectPluginSessionEntryPatch,
  type SessionStoreReadParams,
  toSessionAccessScope,
} from "./session-store-runtime-internal.js";
import type { SessionTranscriptEvent } from "./session-transcript-runtime.js";
export { SessionStoreAgentIdRequiredError } from "../config/sessions/paths.js";

export {
  deliveryContextFromSession,
  sessionDeliveryChannel,
  sessionDeliveryOrigin,
  sessionDeliveryRoute,
} from "../utils/delivery-context.read.js";
export {
  normalizeSessionDeliveryState,
  projectSessionDeliveryFields,
} from "../utils/delivery-context.shared.js";

const SQLITE_SESSION_STORE_BACKUP_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;
type SessionStoreListParams = Partial<Omit<SessionStoreReadParams, "sessionKey">>;

type SessionStoreEntrySummary = {
  sessionKey: string;
  entry: SessionEntry;
};

export type SessionStoreTranscriptEvent = SessionTranscriptEvent;

type SessionStoreEntryUpdate = (
  entry: SessionEntry,
) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null;

type SessionStoreEntryPatch = (
  entry: SessionEntry,
  context: { existingEntry?: SessionEntry },
) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null;

type PatchSessionEntryParams = SessionStoreReadParams & {
  /** Synchronous final ownership check executed inside the commit transaction. */
  assertCommitAllowed?: () => void;
  fallbackEntry?: SessionEntry;
  maintenanceConfig?: ResolvedSessionMaintenanceConfigInput;
  preserveActivity?: boolean;
  requireWriteSuccess?: boolean;
  replaceEntry?: boolean;
  skipMaintenance?: boolean;
  update: SessionStoreEntryPatch;
};

type UpdateSessionStoreEntryParams = {
  storePath: string;
  sessionKey: string;
  update: SessionStoreEntryUpdate;
  skipMaintenance?: boolean;
  takeCacheOwnership?: boolean;
  requireWriteSuccess?: boolean;
};

type UpsertSessionEntryParams = SessionStoreReadParams & { entry: SessionEntry };

type ReadAmbientTranscriptWatermarkParams = SessionStoreReadParams & {
  key: string;
};

type DeleteSessionEntryParams = SessionStoreReadParams & {
  archiveTranscript?: boolean;
  expectedSessionId?: string | null;
  expectedUpdatedAt?: number;
};

type SessionLifecycleArtifactsCleanupParams = {
  agentId?: string;
  archiveRemovedEntryTranscripts?: boolean;
  env?: NodeJS.ProcessEnv;
  orphanTranscriptMinAgeMs: number;
  pluginOwnerId?: string;
  sessionStore?: string;
  sessionKeySegmentPrefix: string;
  storePath?: string;
  transcriptContentMarker: string;
  nowMs?: number;
};

type SessionLifecycleArtifactsCleanupResult = {
  archivedTranscriptArtifacts: number;
  removedEntries: number;
};

function preserveGenerationPrivateFields(
  persistedEntry: InternalSessionEntry,
  publicPatch: Partial<SessionEntry>,
): Partial<InternalSessionEntry> {
  const nextSessionId = Object.hasOwn(publicPatch, "sessionId")
    ? publicPatch.sessionId
    : persistedEntry.sessionId;
  const nextLifecycleRevision = Object.hasOwn(publicPatch, "lifecycleRevision")
    ? publicPatch.lifecycleRevision
    : persistedEntry.lifecycleRevision;
  const privateFields = generationValidPrivateFieldsForSameSession(
    persistedEntry,
    nextSessionId,
    nextLifecycleRevision,
  );
  return privateFields
    ? {
        ...publicPatch,
        ...(!Object.hasOwn(publicPatch, "lifecycleRevision") &&
        persistedEntry.lifecycleRevision !== undefined
          ? { lifecycleRevision: persistedEntry.lifecycleRevision }
          : {}),
        ...privateFields,
      }
    : clearGenerationPrivateFieldsForRotatedSessionPatch(persistedEntry, publicPatch);
}

/** Resolves the configured session store path without selecting a row-operation agent. */
export { resolveSessionStorePathCore as resolveStorePath } from "../config/sessions/paths.js";

/** Loads one session entry by agent/session identity. */
export function getSessionEntry(params: SessionStoreReadParams): SessionEntry | undefined {
  const entry = loadSessionEntryReadOnly(toSessionAccessScope(params));
  return entry ? projectPluginSessionEntry(entry) : undefined;
}

/** Reads the current session binding of one canonical transport address. */
export function getConversationSession(params: {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
  channel: string;
  accountId: string;
  kind: "channel" | "direct" | "group";
  peerId: string;
  threadId?: string;
}): { sessionKey: string; sessionId: string } | undefined {
  const identity = buildConversationIdentity({ ...params, deliveryTarget: params.peerId });
  return identity ? resolveCurrentConversationSession(params, identity.conversationRef) : undefined;
}

/**
 * Lists session entries for one agent. `readOnly` reads without joining the
 * agent database writable lifecycle (no create/register/migrate) — required
 * for detection/introspection paths that may run across the whole fleet.
 */
export function listSessionEntries(
  params: SessionStoreListParams & { readOnly?: boolean } = {},
): SessionStoreEntrySummary[] {
  const list = params.readOnly ? listAccessorSessionEntriesReadOnly : listAccessorSessionEntries;
  return list({
    ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
    ...(params.env !== undefined ? { env: params.env } : {}),
    ...(params.hydrateSkillPromptRefs !== undefined
      ? { hydrateSkillPromptRefs: params.hydrateSkillPromptRefs }
      : {}),
    ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
  }).map(({ sessionKey, entry }) => ({
    sessionKey,
    entry: projectPluginSessionEntry(entry),
  }));
}

/** Reads transcript events for a live SQLite-backed session identity. */
export const loadTranscriptEventsSync: (params: {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  sessionId: string;
  sessionKey?: string;
  storePath?: string;
}) => SessionStoreTranscriptEvent[] = loadAccessorTranscriptEventsSync;

/** Reads transcript freshness and byte size without materializing event rows. */
export const readTranscriptStatsSync: (params: {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  sessionId: string;
  sessionKey?: string;
  storePath?: string;
}) => { eventCount: number; maxSeq: number; sizeBytes: number } = readAccessorTranscriptStatsSync;

/** Resolves the persisted session key for one SQLite transcript identity. */
export { resolveTranscriptSessionKeyBySessionId } from "../config/sessions/session-accessor.js";

/** Patches one session entry by agent/session identity. */
export async function patchSessionEntry(
  params: PatchSessionEntryParams,
): Promise<SessionEntry | null> {
  const entry = await patchAccessorSessionEntry(
    toSessionAccessScope(params),
    async (internalEntry, context) => {
      const persistedEntry = internalEntry as InternalSessionEntry;
      const patch = await params.update(projectPluginSessionEntry(internalEntry), {
        existingEntry: context.existingEntry
          ? projectPluginSessionEntry(context.existingEntry)
          : undefined,
      });
      if (!patch) {
        return null;
      }
      return preserveGenerationPrivateFields(persistedEntry, projectPluginSessionEntryPatch(patch));
    },
    {
      ...sessionEntryCommitGuardOptions(
        captureExternalSessionCommitGuard(params.assertCommitAllowed),
      ),
      fallbackEntry: params.fallbackEntry
        ? projectPluginSessionEntry(params.fallbackEntry)
        : undefined,
      maintenanceConfig:
        params.maintenanceConfig !== undefined
          ? normalizeResolvedMaintenanceConfigInput(params.maintenanceConfig)
          : undefined,
      preserveActivity: params.preserveActivity,
      requireWriteSuccess: params.requireWriteSuccess,
      replaceEntry: params.replaceEntry,
      skipMaintenance: params.skipMaintenance,
    },
  );
  return entry ? projectPluginSessionEntry(entry) : null;
}

/** @deprecated Use readSessionUpdatedAtAsync. Retained until the next Plugin SDK major. */
export function readSessionUpdatedAt(params: SessionStoreReadParams): number | undefined {
  return readAccessorSessionUpdatedAt(toSessionAccessScope(params));
}

/** Reads the last activity timestamp without creating a missing session store. */
export function readSessionUpdatedAtAsync(
  params: SessionStoreReadParams,
): Promise<number | undefined> {
  return readSessionUpdatedAtInWorker(toSessionAccessScope(params));
}

export { resolveAmbientTranscriptWatermarkKey, updateAmbientTranscriptWatermark };
export type { AmbientTranscriptWatermarkScope };

export function readAmbientTranscriptWatermark(
  params: ReadAmbientTranscriptWatermarkParams,
): AmbientTranscriptWatermark | undefined {
  return readAmbientTranscriptWatermarkFromEntry(getSessionEntry(params), params.key);
}

/** Updates an existing session entry by store path and session key. */
export async function updateSessionStoreEntry(
  params: UpdateSessionStoreEntryParams,
): Promise<SessionEntry | null> {
  const entry = await updateSessionEntry(
    { sessionKey: params.sessionKey, storePath: params.storePath },
    async (internalEntry) => {
      const patch = await params.update(projectPluginSessionEntry(internalEntry));
      if (!patch) {
        return null;
      }
      const persistedEntry = internalEntry as InternalSessionEntry;
      return preserveGenerationPrivateFields(persistedEntry, projectPluginSessionEntryPatch(patch));
    },
    {
      skipMaintenance: params.skipMaintenance,
      takeCacheOwnership: params.takeCacheOwnership,
      requireWriteSuccess: params.requireWriteSuccess,
    },
  );
  return entry ? projectPluginSessionEntry(entry) : null;
}

/** Replaces or creates one session entry by agent/session identity. */
export async function upsertSessionEntry(params: UpsertSessionEntryParams): Promise<void> {
  const publicEntry = projectPluginSessionEntry(params.entry);
  await patchAccessorSessionEntry(
    toSessionAccessScope(params),
    (internalEntry) => {
      const persistedEntry = internalEntry as InternalSessionEntry;
      return preserveGenerationPrivateFields(persistedEntry, publicEntry);
    },
    { fallbackEntry: publicEntry, replaceEntry: true },
  );
}

/** Deletes one session entry by agent/session identity. */
export async function deleteSessionEntry(params: DeleteSessionEntryParams): Promise<boolean> {
  const agentId = params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey);
  const storePath =
    params.storePath ??
    resolveSessionStorePathCore(undefined, {
      agentId,
      env: params.env,
    });
  const result = await deleteAccessorSessionEntryLifecycle({
    ...(agentId !== undefined ? { agentId } : {}),
    ...(params.env !== undefined ? { env: params.env } : {}),
    archiveTranscript: params.archiveTranscript ?? false,
    ...(params.expectedSessionId !== undefined
      ? { expectedSessionId: params.expectedSessionId }
      : {}),
    ...(params.expectedUpdatedAt !== undefined
      ? { expectedUpdatedAt: params.expectedUpdatedAt }
      : {}),
    storePath,
    target: {
      canonicalKey: params.sessionKey,
      storeKeys: [params.sessionKey],
    },
  });
  return result.deleted;
}

/** Resolves the file artifacts that should be backed up before mutating a session store. */
export function resolveSessionStoreBackupPaths(params: {
  agentId?: string;
  storePath: string;
}): string[] {
  const backupPaths = new Set<string>();
  backupPaths.add(path.resolve(params.storePath));

  const sqlitePath = resolveSqliteTargetFromSessionStorePath(params.storePath, {
    agentId: params.agentId,
  }).path;
  if (sqlitePath) {
    for (const suffix of SQLITE_SESSION_STORE_BACKUP_SUFFIXES) {
      backupPaths.add(`${sqlitePath}${suffix}`);
    }
  }

  return [...backupPaths];
}

/**
 * Cleans stale lifecycle-owned session entries and orphan transcripts for one agent store.
 * Joins pending startup preparation before capturing the database identity; failed preparation
 * still surfaces through normal admission checks. Prepared agents do not wait.
 */
export async function cleanupSessionLifecycleArtifacts(
  params: SessionLifecycleArtifactsCleanupParams,
): Promise<SessionLifecycleArtifactsCleanupResult> {
  const storePath =
    params.storePath ??
    resolveSessionStorePathCore(params.sessionStore, {
      agentId: params.agentId,
      env: params.env,
    });
  return await cleanupAccessorSessionLifecycleArtifacts({
    storePath,
    ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
    ...(params.env !== undefined ? { env: params.env } : {}),
    archiveRemovedEntryTranscripts: params.archiveRemovedEntryTranscripts,
    ...(params.pluginOwnerId !== undefined ? { pluginOwnerId: params.pluginOwnerId } : {}),
    sessionKeySegmentPrefix: params.sessionKeySegmentPrefix,
    transcriptContentMarker: params.transcriptContentMarker,
    orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
    nowMs: params.nowMs,
  });
}

export {
  formatSqliteSessionFileMarker,
  parseSqliteSessionFileMarker,
  sqliteSessionFileMarkerMatchesSession,
  type SqliteSessionFileMarker,
} from "../config/sessions/legacy-sqlite-marker.js";
export {
  readRecentUserAssistantTextForSession,
  type SessionRecentConversationText,
} from "../config/sessions/transcript.js";
export { resolveSessionKey } from "../config/sessions/session-key.js";
export { resolveGroupSessionKey } from "../config/sessions/group.js";
export { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
export { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
export { isValidAgentHarnessSessionStoreEntry } from "../sessions/agent-harness-session-key.js";
// SDK-facing names are a shipped plugin contract; internals route through the
// session accessor so the storage backend can change beneath them.
export {
  recordInboundSessionMeta as recordSessionMetaFromInbound,
  updateSessionLastRoute as updateLastRoute,
} from "../config/sessions/session-accessor.js";
export {
  evaluateSessionFreshness,
  resolveChannelResetConfig,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  resolveThreadFlag,
} from "../config/sessions/reset.js";
export { resolveSendPolicy } from "../sessions/send-policy.js";
export type { SessionEntry } from "../config/sessions/types.js";
export type { SessionScope } from "../config/sessions/types.js";
