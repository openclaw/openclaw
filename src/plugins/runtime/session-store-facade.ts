import type { InternalSessionEntry } from "../../config/sessions/main-session-recovery.types.js";
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
import type { SessionEntry } from "../../config/sessions/types.js";

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

export function toPluginSessionAccessScope(params: SessionStoreReadParams): SessionAccessScope {
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
  return publicEntry;
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

function recoveryStateForSameSession(
  existingEntry: InternalSessionEntry | undefined,
  nextSessionId: string | undefined,
): InternalSessionEntry["mainRestartRecovery"] {
  return existingEntry && existingEntry.sessionId === nextSessionId
    ? existingEntry.mainRestartRecovery
    : undefined;
}

function indexSessionKeysBySessionId(
  store: Record<string, Pick<SessionEntry, "sessionId">>,
): Map<string, string[]> {
  const keysBySessionId = new Map<string, string[]>();
  for (const [sessionKey, entry] of Object.entries(store)) {
    if (!entry.sessionId) {
      continue;
    }
    const existing = keysBySessionId.get(entry.sessionId);
    if (existing) {
      existing.push(sessionKey);
    } else {
      keysBySessionId.set(entry.sessionId, [sessionKey]);
    }
  }
  return keysBySessionId;
}

function clearRecoveryStateForRotatedMergePatch(
  existingEntry: InternalSessionEntry,
  publicPatch: Partial<SessionEntry>,
): Partial<InternalSessionEntry> {
  const nextSessionId = publicPatch.sessionId ?? existingEntry.sessionId;
  return nextSessionId !== existingEntry.sessionId
    ? { ...publicPatch, mainRestartRecovery: undefined }
    : publicPatch;
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
    let existingRecovery = recoveryStateForSameSession(
      originalStore[sessionKey],
      projectedEntry.sessionId,
    );
    if (existingRecovery === undefined && projectedEntry.sessionId) {
      const originalKeys = originalKeysBySessionId.get(projectedEntry.sessionId);
      const publicKeys = publicKeysBySessionId.get(projectedEntry.sessionId);
      if (originalKeys?.length === 1 && publicKeys?.length === 1) {
        existingRecovery = originalStore[originalKeys[0]!]?.mainRestartRecovery;
      }
    }
    params.internalStore[sessionKey] = existingRecovery
      ? { ...projectedEntry, mainRestartRecovery: existingRecovery }
      : projectedEntry;
  }
}

export function getPluginSessionEntry(params: SessionStoreReadParams): SessionEntry | undefined {
  const entry = loadSessionEntry(toPluginSessionAccessScope(params));
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
    toPluginSessionAccessScope(params),
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
      const existingRecovery = recoveryStateForSameSession(persistedEntry, publicPatch.sessionId);
      return params.replaceEntry
        ? {
            ...publicPatch,
            ...(existingRecovery ? { mainRestartRecovery: existingRecovery } : {}),
          }
        : clearRecoveryStateForRotatedMergePatch(persistedEntry, publicPatch);
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
      return patch
        ? clearRecoveryStateForRotatedMergePatch(
            internalEntry as InternalSessionEntry,
            projectPluginSessionEntryPatch(patch),
          )
        : null;
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
    toPluginSessionAccessScope(params),
    (internalEntry) => {
      const existingRecovery = recoveryStateForSameSession(
        internalEntry as InternalSessionEntry,
        publicEntry.sessionId,
      );
      return {
        ...publicEntry,
        ...(existingRecovery ? { mainRestartRecovery: existingRecovery } : {}),
      };
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
