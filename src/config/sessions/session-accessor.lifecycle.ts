import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import {
  clearPluginHostCleanupTarget,
  hasPluginHostCleanupTarget,
  isLockedHarnessSessionOwnedByPlugin,
  matchesPluginHostCleanupSession,
  shouldSkipPluginHostCleanupStore,
  type PluginHostSessionCleanupStoreParams,
} from "./plugin-host-cleanup.js";
import { patchSessionEntryCore } from "./session-accessor.entry.js";
import { applySessionEntryCanonicalReplacements } from "./session-accessor.sqlite-replacement-projection.js";
import type {
  SessionPatchProjectionSnapshot,
  SessionPatchProjectionTarget,
  SessionPatchProjectionContext,
  SessionPatchProjectionFailure,
  SessionPatchProjectionResult,
} from "./session-accessor.types.js";
import { readSessionEntrySummariesInWorker } from "./session-entry-read-runtime.js";
import {
  resolveProjectionExistingEntry,
  SessionLabelOwnerIndex,
} from "./session-entry-selection.js";
export { cleanupSessionLifecycleArtifactsCore } from "./session-accessor.sqlite-artifact-cleanup.js";
export {
  deleteSessionEntryLifecycle,
  rollbackAgentHarnessSessionEntryLifecycle,
  rollbackPluginOwnedSessionEntryLifecycle,
  resetSessionEntryLifecycle,
} from "./session-accessor.sqlite-lifecycle.js";
export {
  applySessionEntryLifecycleMutation,
  applySessionEntryReplacements,
  purgeDeletedAgentSessionEntries,
} from "./session-accessor.sqlite-projection.js";

/** Projects one session patch against its detached store snapshot and commits once. */
export async function applySessionPatchProjection<
  TFailure extends SessionPatchProjectionFailure,
>(params: {
  agentId?: string;
  /** Revalidates request-scoped authorization after projection and before persistence. */
  assertCurrent?: () => void;
  /** Complete key authority for resolvers that can operate on a bounded store view. */
  sessionKeys?: readonly string[];
  storePath: string;
  resolveTarget: (snapshot: SessionPatchProjectionSnapshot) => SessionPatchProjectionTarget;
  project: (
    context: SessionPatchProjectionContext,
  ) => Promise<SessionPatchProjectionResult<TFailure>> | SessionPatchProjectionResult<TFailure>;
}): Promise<SessionPatchProjectionResult<TFailure>> {
  return await applySessionEntryCanonicalReplacements<SessionPatchProjectionResult<TFailure>>({
    agentId: params.agentId,
    sessionKeys: params.sessionKeys,
    storePath: params.storePath,
    skipMaintenance: true,
    update: async (entries) => {
      const workingStore = Object.fromEntries(
        entries.flatMap(({ entry, sessionKey }) =>
          isInternalSessionEffectsKey(sessionKey) ? [] : [[sessionKey, entry] as const],
        ),
      );
      const snapshot = { store: workingStore };
      const labelOwners = new SessionLabelOwnerIndex(workingStore);
      const target = params.resolveTarget(snapshot);
      const existingEntry = resolveProjectionExistingEntry(snapshot, target);
      const candidateKeys = uniqueStrings(
        (target.candidateKeys ?? [target.primaryKey]).map((key) => key.trim()).filter(Boolean),
      );
      const projected = await params.project({
        ...target,
        ...snapshot,
        ...(existingEntry ? { existingEntry } : {}),
        isLabelInUse: (label) => labelOwners.isLabelInUse(label, candidateKeys),
      });
      if (!projected.ok) {
        return { result: projected };
      }
      params.assertCurrent?.();
      const previousSessionKeys = candidateKeys.filter(
        (sessionKey) => sessionKey !== target.primaryKey && workingStore[sessionKey],
      );
      const cloned = labelOwners.replaceEntry(candidateKeys, target.primaryKey, projected.entry);
      return {
        replacements: [
          { entry: projected.entry, previousSessionKeys, sessionKey: target.primaryKey },
        ],
        result: { ok: true, entry: structuredClone(cloned) },
      };
    },
  });
}

/**
 * Clears plugin host-owned state inside one resolved session store.
 * This is an internal transaction-sized boundary for the storage backend, not
 * a Plugin SDK API.
 */
export async function cleanupPluginHostSessionStore(
  params: PluginHostSessionCleanupStoreParams,
): Promise<number> {
  if (
    shouldSkipPluginHostCleanupStore(params) ||
    (params.shouldCleanup && !params.shouldCleanup())
  ) {
    return 0;
  }
  const now = Date.now();
  let cleared = 0;
  for (const { entry, sessionKey } of await readSessionEntrySummariesInWorker({
    agentId: params.agentId,
    storePath: params.storePath,
    cleanupSession: params.sessionKey,
  })) {
    if (isLockedHarnessSessionOwnedByPlugin(entry, params.preserveLockedHarnessIds)) {
      continue;
    }
    if (!hasPluginHostCleanupTarget(entry, params)) {
      continue;
    }
    if (params.shouldCleanup && !params.shouldCleanup()) {
      break;
    }
    await patchSessionEntryCore(
      { agentId: params.agentId, sessionKey, storePath: params.storePath },
      (currentEntry) => {
        if (isLockedHarnessSessionOwnedByPlugin(currentEntry, params.preserveLockedHarnessIds)) {
          return null;
        }
        if (
          !matchesPluginHostCleanupSession(sessionKey, currentEntry, params.sessionKey) ||
          !hasPluginHostCleanupTarget(currentEntry, params)
        ) {
          return null;
        }
        clearPluginHostCleanupTarget(currentEntry, params);
        currentEntry.updatedAt = now;
        return currentEntry;
      },
      {
        shouldCommit: params.shouldCleanup,
        onCommitted: () => {
          cleared += 1;
        },
        replaceEntry: true,
        skipMaintenance: true,
      },
    );
  }
  return cleared;
}
