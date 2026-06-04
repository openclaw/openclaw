// Narrow session-store helpers for channel hot paths.

import {
  cleanupSessionLifecycleArtifacts,
  listSessionEntries as listAccessorSessionEntries,
  loadSessionEntry,
  patchSessionEntry as patchAccessorSessionEntry,
  readSessionUpdatedAt as readAccessorSessionUpdatedAt,
  replaceSessionEntry,
  type SessionAccessScope,
  type SessionLifecycleArtifactCleanupParams,
  type SessionLifecycleArtifactCleanupResult,
  updateSessionEntry,
} from "../config/sessions/session-accessor.js";
import { loadSessionStore as loadSessionStoreImpl } from "../config/sessions/store-load.js";
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
 * the legacy mutable sessions.json shape and are compatibility escape hatches.
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
    },
  );
}

/** Replaces or creates one session entry through the accessor seam. */
export async function upsertSessionEntry(params: UpsertSessionEntryParams): Promise<void> {
  await replaceSessionEntry(toSessionAccessScope(params), params.entry);
}

export { resolveSessionStoreEntry } from "../config/sessions/store-entry.js";
export {
  resolveSessionFilePath,
  resolveSessionTranscriptPathInDir,
  resolveStorePath,
} from "../config/sessions/paths.js";
export { resolveAndPersistSessionFile } from "../config/sessions/session-file.js";
export { readLatestAssistantTextFromSessionTranscript } from "../config/sessions/transcript.js";
export { resolveSessionKey } from "../config/sessions/session-key.js";
export { resolveGroupSessionKey } from "../config/sessions/group.js";
export { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
export {
  clearSessionStoreCacheForTest,
  recordSessionMetaFromInbound,
  saveSessionStore,
  updateLastRoute,
  updateSessionStore,
} from "../config/sessions/store.js";
export type { SessionLifecycleArtifactCleanupParams, SessionLifecycleArtifactCleanupResult };
export { cleanupSessionLifecycleArtifacts };
export {
  evaluateSessionFreshness,
  resolveChannelResetConfig,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  resolveThreadFlag,
} from "../config/sessions/reset.js";
export { resolveSendPolicy } from "../sessions/send-policy.js";
export type { SessionEntry, SessionScope } from "../config/sessions/types.js";
