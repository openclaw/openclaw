import {
  patchSessionEntry as patchAccessorSessionEntry,
  updateSessionEntry,
} from "../config/sessions/session-accessor.js";
import { normalizeResolvedMaintenanceConfigInput } from "../config/sessions/store-maintenance.js";
import type { ResolvedSessionMaintenanceConfigInput } from "../config/sessions/store.js";
import type { InternalSessionEntry, SessionEntry } from "../config/sessions/types.js";
import {
  clearRecoveryStateForRotatedSessionPatch,
  projectPluginSessionEntry,
  projectPluginSessionEntryPatch,
  activeRecoveryFieldsForSameSession,
  type SessionStoreReadParams,
  toSessionAccessScope,
} from "./session-store-runtime-internal.js";

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

/** Patches one public plugin session entry without exposing core recovery coordination. */
export async function patchPluginSessionEntry(
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
      const publicPatch = projectPluginSessionEntryPatch(patch);
      const nextSessionId = Object.hasOwn(publicPatch, "sessionId")
        ? publicPatch.sessionId
        : persistedEntry.sessionId;
      const existingRecovery = activeRecoveryFieldsForSameSession(persistedEntry, nextSessionId);
      return params.replaceEntry
        ? existingRecovery
          ? { ...publicPatch, ...existingRecovery }
          : clearRecoveryStateForRotatedSessionPatch(persistedEntry, publicPatch)
        : existingRecovery
          ? { ...publicPatch, ...existingRecovery }
          : clearRecoveryStateForRotatedSessionPatch(persistedEntry, publicPatch);
    },
    {
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

/** Updates one public plugin session entry by store path and session key. */
export async function updatePluginSessionStoreEntry(
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
      const publicPatch = projectPluginSessionEntryPatch(patch);
      const nextSessionId = Object.hasOwn(publicPatch, "sessionId")
        ? publicPatch.sessionId
        : persistedEntry.sessionId;
      const existingRecovery = activeRecoveryFieldsForSameSession(persistedEntry, nextSessionId);
      return existingRecovery
        ? { ...publicPatch, ...existingRecovery }
        : clearRecoveryStateForRotatedSessionPatch(persistedEntry, publicPatch);
    },
    {
      skipMaintenance: params.skipMaintenance,
      takeCacheOwnership: params.takeCacheOwnership,
      requireWriteSuccess: params.requireWriteSuccess,
    },
  );
  return entry ? projectPluginSessionEntry(entry) : null;
}

/** Replaces or creates one public plugin session entry. */
export async function upsertPluginSessionEntry(params: UpsertSessionEntryParams): Promise<void> {
  const publicEntry = projectPluginSessionEntry(params.entry);
  await patchAccessorSessionEntry(
    toSessionAccessScope(params),
    (internalEntry) => {
      const persistedEntry = internalEntry as InternalSessionEntry;
      const existingRecovery = activeRecoveryFieldsForSameSession(
        persistedEntry,
        publicEntry.sessionId,
      );
      return existingRecovery
        ? { ...publicEntry, ...existingRecovery }
        : clearRecoveryStateForRotatedSessionPatch(persistedEntry, publicEntry);
    },
    { fallbackEntry: publicEntry, replaceEntry: true },
  );
}
