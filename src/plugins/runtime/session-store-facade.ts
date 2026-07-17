// Canonical plugin-facing session projection and mutation boundary.
import { MAIN_SESSION_RECOVERY_CLEAR_PATCH } from "../../agents/main-session-recovery-clear.js";
import {
  listSessionEntries as listAccessorSessionEntries,
  loadSessionEntry,
  patchSessionEntry as patchAccessorSessionEntry,
  recordInboundSessionMeta as recordAccessorInboundSessionMeta,
  updateSessionEntry,
  updateSessionLastRoute as updateAccessorSessionLastRoute,
  type RecordInboundSessionMetaParams,
  type SessionAccessScope,
  type UpdateSessionLastRouteParams,
} from "../../config/sessions/session-accessor.js";
import { normalizeResolvedMaintenanceConfigInput } from "../../config/sessions/store-maintenance.js";
import type { ResolvedSessionMaintenanceConfigInput } from "../../config/sessions/store.js";
import type { InternalSessionEntry, SessionEntry } from "../../config/sessions/types.js";

export type SessionStoreReadParams = {
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

export function toSessionAccessScope(params: SessionStoreReadParams): SessionAccessScope {
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

export function projectPluginSessionEntry(entry: InternalSessionEntry): SessionEntry {
  const { mainRestartRecovery: _mainRestartRecovery, ...publicEntry } = entry;
  return {
    ...publicEntry,
    ...(entry.restartRecoveryRuns
      ? { restartRecoveryRuns: entry.restartRecoveryRuns.map((run) => ({ ...run })) }
      : {}),
  };
}

function projectPluginSessionEntryPatch(
  patch: Partial<InternalSessionEntry>,
): Partial<SessionEntry> {
  const { mainRestartRecovery: _mainRestartRecovery, ...publicPatch } = patch;
  return publicPatch;
}

export function projectPluginSessionStore(
  store: Record<string, InternalSessionEntry>,
): Record<string, SessionEntry> {
  return Object.fromEntries(
    Object.entries(store).map(([sessionKey, entry]) => [
      sessionKey,
      projectPluginSessionEntry(entry),
    ]),
  );
}

function activeRecoveryFieldsForSameSession(
  existingEntry: InternalSessionEntry | undefined,
  nextSessionId: string | undefined,
): Partial<InternalSessionEntry> | undefined {
  if (
    !existingEntry ||
    existingEntry.sessionId !== nextSessionId ||
    existingEntry.mainRestartRecovery === undefined
  ) {
    return undefined;
  }
  return {
    abortedLastRun: existingEntry.abortedLastRun,
    restartRecoveryRuns: existingEntry.restartRecoveryRuns,
    mainRestartRecovery: existingEntry.mainRestartRecovery,
  };
}

function clearRecoveryStateForRotatedSessionPatch(
  existingEntry: InternalSessionEntry,
  publicPatch: Partial<SessionEntry>,
): Partial<InternalSessionEntry> {
  return Object.hasOwn(publicPatch, "sessionId") &&
    publicPatch.sessionId !== existingEntry.sessionId
    ? { ...publicPatch, ...MAIN_SESSION_RECOVERY_CLEAR_PATCH }
    : publicPatch;
}

function indexSessionKeysBySessionId(
  store: Record<string, Pick<SessionEntry, "sessionId">>,
): Map<string, string[]> {
  const keysBySessionId = new Map<string, string[]>();
  for (const [sessionKey, entry] of Object.entries(store)) {
    if (!entry.sessionId) {
      continue;
    }
    const keys = keysBySessionId.get(entry.sessionId);
    if (keys) {
      keys.push(sessionKey);
    } else {
      keysBySessionId.set(entry.sessionId, [sessionKey]);
    }
  }
  return keysBySessionId;
}

export function reconcilePluginSessionStore(params: {
  internalStore: Record<string, InternalSessionEntry>;
  publicStore: Record<string, SessionEntry>;
}): void {
  const originalStore = { ...params.internalStore };
  const originalKeysBySessionId = indexSessionKeysBySessionId(originalStore);
  const publicKeysBySessionId = indexSessionKeysBySessionId(params.publicStore);

  for (const sessionKey of Object.keys(params.internalStore)) {
    if (!Object.hasOwn(params.publicStore, sessionKey)) {
      delete params.internalStore[sessionKey];
    }
  }
  for (const [sessionKey, publicEntry] of Object.entries(params.publicStore)) {
    const projectedEntry = projectPluginSessionEntry(publicEntry as InternalSessionEntry);
    const originalEntry = originalStore[sessionKey];
    let existingRecovery = activeRecoveryFieldsForSameSession(
      originalEntry,
      projectedEntry.sessionId,
    );
    if (!existingRecovery && projectedEntry.sessionId) {
      const originalKeys = originalKeysBySessionId.get(projectedEntry.sessionId);
      const publicKeys = publicKeysBySessionId.get(projectedEntry.sessionId);
      if (originalKeys?.length === 1 && publicKeys?.length === 1) {
        existingRecovery = activeRecoveryFieldsForSameSession(
          originalStore[originalKeys[0]!],
          projectedEntry.sessionId,
        );
      }
    }
    params.internalStore[sessionKey] =
      originalEntry && originalEntry.sessionId !== projectedEntry.sessionId
        ? existingRecovery
          ? { ...projectedEntry, ...existingRecovery }
          : { ...projectedEntry, ...MAIN_SESSION_RECOVERY_CLEAR_PATCH }
        : existingRecovery
          ? { ...projectedEntry, ...existingRecovery }
          : projectedEntry;
  }
}

export function getPluginSessionEntry(params: SessionStoreReadParams): SessionEntry | undefined {
  const entry = loadSessionEntry(toSessionAccessScope(params));
  return entry ? projectPluginSessionEntry(entry) : undefined;
}

export function listPluginSessionEntries(
  params: SessionStoreListParams = {},
): SessionStoreEntrySummary[] {
  return listAccessorSessionEntries({
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
      return existingRecovery
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

export async function recordPluginSessionMetaFromInbound(
  params: RecordInboundSessionMetaParams,
): Promise<SessionEntry | null> {
  const entry = await recordAccessorInboundSessionMeta(params);
  return entry ? projectPluginSessionEntry(entry) : null;
}

export async function updatePluginSessionLastRoute(
  params: UpdateSessionLastRouteParams,
): Promise<SessionEntry | null> {
  const entry = await updateAccessorSessionLastRoute(params);
  return entry ? projectPluginSessionEntry(entry) : null;
}
