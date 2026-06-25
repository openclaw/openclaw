// Narrow session-store helpers for channel hot paths.

import { resolveStorePath as resolveSessionStorePath } from "../config/sessions/paths.js";
import {
  cleanupSessionLifecycleArtifacts as cleanupAccessorSessionLifecycleArtifacts,
  listSessionEntries as listAccessorSessionEntries,
  loadSessionEntry,
  patchSessionEntry as patchAccessorSessionEntry,
  readSessionUpdatedAt as readAccessorSessionUpdatedAt,
  replaceSessionEntry,
  type SessionAccessScope,
  updateSessionEntry,
} from "../config/sessions/session-accessor.js";
import { loadSessionStore as loadSessionStoreImpl } from "../config/sessions/store-load.js";
import { normalizeResolvedMaintenanceConfigInput } from "../config/sessions/store-maintenance.js";
import type { ResolvedSessionMaintenanceConfigInput } from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";

type SessionStoreReadParams = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  hydrateSkillPromptRefs?: boolean;
  readConsistency?: "latest";
  sessionKey: string;
  storePath?: string;
};

type SessionStoreListParams = Partial<Omit<SessionStoreReadParams, "sessionKey">>;

type SessionStoreEntrySummary = {
  sessionKey: string;
  entry: SessionEntry;
};

type SessionStoreEntryUpdate = (
  entry: SessionEntry,
) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null;

type SessionStoreEntryPatch = (
  entry: SessionEntry,
  context: { existingEntry?: SessionEntry },
) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null;

type PatchSessionEntryParams = SessionStoreReadParams & {
  fallbackEntry?: SessionEntry;
  maintenanceConfig?: ResolvedSessionMaintenanceConfigInput;
  preserveActivity?: boolean;
  replaceEntry?: boolean;
  update: SessionStoreEntryPatch;
};

type ReadSessionUpdatedAtParams = SessionStoreReadParams;

type UpdateSessionStoreEntryParams = {
  storePath: string;
  sessionKey: string;
  update: SessionStoreEntryUpdate;
  skipMaintenance?: boolean;
  takeCacheOwnership?: boolean;
  requireWriteSuccess?: boolean;
};

type UpsertSessionEntryParams = SessionStoreReadParams & {
  entry: SessionEntry;
};

type SessionLifecycleArtifactsCleanupParams = {
  agentId?: string;
  archiveRemovedEntryTranscripts?: boolean;
  env?: NodeJS.ProcessEnv;
  orphanTranscriptMinAgeMs: number;
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

function toSessionAccessScope(params: SessionStoreReadParams): SessionAccessScope {
  // Maintainer note: keep this adapter narrow so plugin callers retain the
  // object-parameter API while internal accessor-only options stay private.
  return {
    sessionKey: params.sessionKey,
    ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
    ...(params.env !== undefined ? { env: params.env } : {}),
    ...(params.hydrateSkillPromptRefs !== undefined
      ? { hydrateSkillPromptRefs: params.hydrateSkillPromptRefs }
      : {}),
    ...(params.readConsistency !== undefined ? { readConsistency: params.readConsistency } : {}),
    ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
  };
}

/**
 * @deprecated Use getSessionEntry/listSessionEntries for reads and
 * patchSessionEntry/upsertSessionEntry for writes. This whole-store helper is
 * kept only during the transition before SQLite migration. Callers must
 * migrate away from reading sessions.json directly.
 */
export const loadSessionStore = loadSessionStoreImpl;

/** Loads one session entry by agent/session identity. */
export function getSessionEntry(params: SessionStoreReadParams): SessionEntry | undefined {
  return loadSessionEntry(toSessionAccessScope(params));
}

/** Lists session entries for one agent. */
export function listSessionEntries(
  params: SessionStoreListParams = {},
): SessionStoreEntrySummary[] {
  return listAccessorSessionEntries({
    ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
    ...(params.env !== undefined ? { env: params.env } : {}),
    ...(params.hydrateSkillPromptRefs !== undefined
      ? { hydrateSkillPromptRefs: params.hydrateSkillPromptRefs }
      : {}),
    ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
  });
}

/** Patches one session entry by agent/session identity. */
export async function patchSessionEntry(
  params: PatchSessionEntryParams,
): Promise<SessionEntry | null> {
  return await patchAccessorSessionEntry(toSessionAccessScope(params), params.update, {
    fallbackEntry: params.fallbackEntry,
    maintenanceConfig:
      params.maintenanceConfig !== undefined
        ? normalizeResolvedMaintenanceConfigInput(params.maintenanceConfig)
        : undefined,
    preserveActivity: params.preserveActivity,
    replaceEntry: params.replaceEntry,
  });
}

/** Reads the last activity timestamp for one session entry. */
export function readSessionUpdatedAt(params: ReadSessionUpdatedAtParams): number | undefined {
  return readAccessorSessionUpdatedAt(toSessionAccessScope(params));
}

/** Updates an existing session entry by store path and session key. */
export async function updateSessionStoreEntry(
  params: UpdateSessionStoreEntryParams,
): Promise<SessionEntry | null> {
  return await updateSessionEntry(
    {
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    params.update,
    {
      skipMaintenance: params.skipMaintenance,
      takeCacheOwnership: params.takeCacheOwnership,
      requireWriteSuccess: params.requireWriteSuccess,
    },
  );
}

/** Replaces or creates one session entry by agent/session identity. */
export async function upsertSessionEntry(params: UpsertSessionEntryParams): Promise<void> {
  await replaceSessionEntry(toSessionAccessScope(params), params.entry);
}

/** Cleans stale lifecycle-owned session entries and orphan transcripts for one agent store. */
export async function cleanupSessionLifecycleArtifacts(
  params: SessionLifecycleArtifactsCleanupParams,
): Promise<SessionLifecycleArtifactsCleanupResult> {
  const storePath =
    params.storePath ??
    resolveSessionStorePath(params.sessionStore, {
      agentId: params.agentId,
      env: params.env,
    });
  return await cleanupAccessorSessionLifecycleArtifacts({
    storePath,
    ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
    archiveRemovedEntryTranscripts: params.archiveRemovedEntryTranscripts,
    sessionKeySegmentPrefix: params.sessionKeySegmentPrefix,
    transcriptContentMarker: params.transcriptContentMarker,
    orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
    nowMs: params.nowMs,
  });
}

export { resolveSessionStoreEntry } from "../config/sessions/store-entry.js";
export { resolveAndPersistSessionFile } from "../config/sessions/session-file.js";
export { resolveSessionTranscriptPathInDir, resolveStorePath } from "../config/sessions/paths.js";
/**
 * @deprecated Use getSessionEntry to read session metadata by agent/session
 * identity instead of resolving transcript file paths. This file-path helper
 * is kept only during the transition before SQLite migration. Callers must
 * migrate away from resolving transcript file paths directly.
 */
export { resolveSessionFilePath } from "../config/sessions/paths.js";
export {
  readLatestAssistantTextFromSessionTranscript,
  readRecentUserAssistantTextForSession,
  type SessionRecentConversationText,
} from "../config/sessions/transcript.js";
export { resolveSessionKey } from "../config/sessions/session-key.js";
export { resolveGroupSessionKey } from "../config/sessions/group.js";
export { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
export {
  clearSessionStoreCacheForTest,
  recordSessionMetaFromInbound,
  updateLastRoute,
} from "../config/sessions/store.js";
/**
 * @deprecated Use patchSessionEntry/upsertSessionEntry for writes. These
 * whole-store helpers are kept only during the transition before SQLite
 * migration. Callers must migrate away from reading or writing sessions.json.
 */
export { saveSessionStore, updateSessionStore } from "../config/sessions/store.js";
// Maintainer note: keep saveSessionStore/updateSessionStore grouped as one
// compatibility operation. A SQLite bridge must diff before/after store shapes,
// apply changed/deleted rows in one write transaction, and publish after commit.
export {
  evaluateSessionFreshness,
  resolveChannelResetConfig,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  resolveThreadFlag,
} from "../config/sessions/reset.js";
export { resolveSendPolicy } from "../sessions/send-policy.js";
export type { SessionEntry, SessionScope } from "../config/sessions/types.js";
