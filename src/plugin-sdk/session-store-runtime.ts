// Narrow session-store helpers for channel hot paths.

import {
  listSessionEntries as listAccessorSessionEntries,
  loadSessionEntry,
  patchSessionEntry as patchAccessorSessionEntry,
  readSessionUpdatedAt as readAccessorSessionUpdatedAt,
  replaceSessionEntry,
  type SessionAccessScope,
  updateSessionEntry,
} from "../config/sessions/session-accessor.js";
import { loadSessionStore as loadSessionStoreImpl } from "../config/sessions/store-load.js";
import type { ResolvedSessionMaintenanceConfig } from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";

type SessionStoreReadParams = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  hydrateSkillPromptRefs?: boolean;
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
  maintenanceConfig?: ResolvedSessionMaintenanceConfig;
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

function toSessionAccessScope(params: SessionStoreReadParams): SessionAccessScope {
  // Preserve the public SDK object-parameter shape while hiding internal seam
  // options such as borrowed reads from exported plugin types.
  return {
    sessionKey: params.sessionKey,
    ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
    ...(params.env !== undefined ? { env: params.env } : {}),
    ...(params.hydrateSkillPromptRefs !== undefined
      ? { hydrateSkillPromptRefs: params.hydrateSkillPromptRefs }
      : {}),
    ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
  };
}

/**
 * @deprecated Use getSessionEntry/listSessionEntries for reads and
 * patchSessionEntry/upsertSessionEntry for writes. Whole-store helpers keep
 * the legacy mutable sessions.json shape only for pre-SQLite compatibility.
 */
export const loadSessionStore = loadSessionStoreImpl;

/** Loads one session entry through the accessor seam. */
export function getSessionEntry(params: SessionStoreReadParams): SessionEntry | undefined {
  return loadSessionEntry(toSessionAccessScope(params));
}

/** Lists session entries through the accessor seam. */
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

/** Patches one session entry through the accessor seam. */
export async function patchSessionEntry(
  params: PatchSessionEntryParams,
): Promise<SessionEntry | null> {
  return await patchAccessorSessionEntry(toSessionAccessScope(params), params.update, {
    fallbackEntry: params.fallbackEntry,
    maintenanceConfig: params.maintenanceConfig,
    preserveActivity: params.preserveActivity,
    replaceEntry: params.replaceEntry,
  });
}

/** Reads a session activity timestamp through the accessor seam. */
export function readSessionUpdatedAt(params: ReadSessionUpdatedAtParams): number | undefined {
  return readAccessorSessionUpdatedAt(toSessionAccessScope(params));
}

/** Updates an existing session entry through the accessor seam. */
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

/** Replaces or creates one session entry through the accessor seam. */
export async function upsertSessionEntry(params: UpsertSessionEntryParams): Promise<void> {
  await replaceSessionEntry(toSessionAccessScope(params), params.entry);
}

export { resolveSessionStoreEntry } from "../config/sessions/store-entry.js";
export { resolveSessionTranscriptPathInDir, resolveStorePath } from "../config/sessions/paths.js";
/**
 * @deprecated Use getSessionEntry to read session metadata by agent/session
 * identity instead of resolving transcript file paths. This file-shaped API is
 * a deprecated pre-SQLite compatibility adapter, not a runtime storage path.
 */
export { resolveSessionFilePath } from "../config/sessions/paths.js";
/**
 * @deprecated Use patchSessionEntry/upsertSessionEntry to persist session
 * metadata by agent/session identity. This file-shaped API is a deprecated
 * pre-SQLite compatibility adapter, not a runtime storage path.
 */
export { resolveAndPersistSessionFile } from "../config/sessions/session-file.js";
export { readLatestAssistantTextFromSessionTranscript } from "../config/sessions/transcript.js";
export { resolveSessionKey } from "../config/sessions/session-key.js";
export { resolveGroupSessionKey } from "../config/sessions/group.js";
export { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
export {
  clearSessionStoreCacheForTest,
  recordSessionMetaFromInbound,
  updateLastRoute,
} from "../config/sessions/store.js";
/**
 * @deprecated Use patchSessionEntry/upsertSessionEntry for storage-neutral
 * writes. Keep this whole-store adapter as one compatibility operation: the
 * file backend owns the sessions.json writer, and a future SQLite bridge must
 * diff before/after store shapes, apply changed/deleted rows in one write
 * transaction, then publish updates after commit. Do not route this through
 * independent per-entry accessors or make it a permanent storage path.
 */
export { saveSessionStore, updateSessionStore } from "../config/sessions/store.js";
export {
  evaluateSessionFreshness,
  resolveChannelResetConfig,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  resolveThreadFlag,
} from "../config/sessions/reset.js";
export { resolveSendPolicy } from "../sessions/send-policy.js";
export type { SessionEntry, SessionScope } from "../config/sessions/types.js";
