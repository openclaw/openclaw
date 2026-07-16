import type { InternalSessionEntry } from "../../config/sessions/main-session-recovery.types.js";
import {
  isCoreRestartRecoverySessionEntryKey,
  type CoreRestartRecoverySessionEntryKey,
} from "../../config/sessions/restart-recovery-private-keys.js";
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

export type PluginSessionEntry = Omit<InternalSessionEntry, CoreRestartRecoverySessionEntryKey>;

type CoreRestartRecoveryState = Partial<
  Pick<InternalSessionEntry, CoreRestartRecoverySessionEntryKey>
>;

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
  entry: PluginSessionEntry;
};

type SessionStoreEntryUpdate = (
  entry: PluginSessionEntry,
) => Promise<Partial<PluginSessionEntry> | null> | Partial<PluginSessionEntry> | null;

type SessionStoreEntryPatch = (
  entry: PluginSessionEntry,
  context: { existingEntry?: PluginSessionEntry },
) => Promise<Partial<PluginSessionEntry> | null> | Partial<PluginSessionEntry> | null;

type PatchSessionEntryParams = SessionStoreReadParams & {
  fallbackEntry?: PluginSessionEntry;
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

type UpsertSessionEntryParams = SessionStoreReadParams & { entry: PluginSessionEntry };

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

export function projectPluginSessionEntry(entry: InternalSessionEntry): PluginSessionEntry {
  const publicEntry = { ...entry } as Record<string, unknown>;
  for (const key of Object.keys(publicEntry)) {
    if (isCoreRestartRecoverySessionEntryKey(key)) {
      delete publicEntry[key];
    }
  }
  return publicEntry as PluginSessionEntry;
}

function projectPluginSessionEntryPatch(
  patch: Partial<InternalSessionEntry>,
): Partial<PluginSessionEntry> {
  const publicPatch = { ...patch } as Record<string, unknown>;
  for (const key of Object.keys(publicPatch)) {
    if (isCoreRestartRecoverySessionEntryKey(key)) {
      delete publicPatch[key];
    }
  }
  return publicPatch as Partial<PluginSessionEntry>;
}

export function projectPluginSessionStore(
  store: Record<string, InternalSessionEntry>,
): Record<string, PluginSessionEntry> {
  return Object.fromEntries(
    Object.entries(store).map(([sessionKey, entry]) => [
      sessionKey,
      projectPluginSessionEntry(entry),
    ]),
  );
}

function readCoreRestartRecoveryState(
  entry: InternalSessionEntry,
): CoreRestartRecoveryState | undefined {
  const recoveryState = {} as Record<string, unknown>;
  for (const [key, value] of Object.entries(entry)) {
    if (isCoreRestartRecoverySessionEntryKey(key)) {
      recoveryState[key] = value;
    }
  }
  return Object.keys(recoveryState).length > 0
    ? (recoveryState as CoreRestartRecoveryState)
    : undefined;
}

function recoveryStateForSameSession(
  existingEntry: InternalSessionEntry | undefined,
  nextSessionId: string | undefined,
): CoreRestartRecoveryState | undefined {
  return existingEntry && existingEntry.sessionId === nextSessionId
    ? readCoreRestartRecoveryState(existingEntry)
    : undefined;
}

function indexSessionKeysBySessionId(
  store: Record<string, Pick<PluginSessionEntry, "sessionId">>,
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
  publicPatch: Partial<PluginSessionEntry>,
): Partial<InternalSessionEntry> {
  const nextSessionId = publicPatch.sessionId ?? existingEntry.sessionId;
  if (nextSessionId === existingEntry.sessionId) {
    return publicPatch;
  }
  const rotatedPatch = { ...publicPatch } as Record<string, unknown>;
  for (const key of Object.keys(existingEntry)) {
    if (isCoreRestartRecoverySessionEntryKey(key)) {
      rotatedPatch[key] = undefined;
    }
  }
  return rotatedPatch as Partial<InternalSessionEntry>;
}

export function reconcilePluginSessionStore(params: {
  internalStore: Record<string, InternalSessionEntry>;
  publicStore: Record<string, PluginSessionEntry>;
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
        const originalEntry = originalStore[originalKeys[0]!];
        existingRecovery = originalEntry ? readCoreRestartRecoveryState(originalEntry) : undefined;
      }
    }
    params.internalStore[sessionKey] = existingRecovery
      ? { ...projectedEntry, ...existingRecovery }
      : projectedEntry;
  }
}

export function getPluginSessionEntry(
  params: SessionStoreReadParams,
): PluginSessionEntry | undefined {
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
): Promise<PluginSessionEntry | null> {
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
            ...existingRecovery,
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
): Promise<PluginSessionEntry | null> {
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
        ...existingRecovery,
      };
    },
    { fallbackEntry: publicEntry, replaceEntry: true },
  );
}

export async function recordPluginSessionMetaFromInbound(
  params: RecordInboundSessionMetaParams,
): Promise<PluginSessionEntry | null> {
  const entry = await recordAccessorInboundSessionMeta(params);
  return entry ? projectPluginSessionEntry(entry) : null;
}

export async function updatePluginSessionLastRoute(
  params: UpdateSessionLastRouteParams,
): Promise<PluginSessionEntry | null> {
  const entry = await updateAccessorSessionLastRoute(params);
  return entry ? projectPluginSessionEntry(entry) : null;
}
