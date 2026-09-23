import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  clearPluginHostCleanupTarget,
  hasPluginHostCleanupTarget,
  isLockedHarnessSessionOwnedByPlugin,
  matchesPluginHostCleanupSession,
  shouldSkipPluginHostCleanupStore,
  type PluginHostSessionCleanupStoreParams,
} from "./plugin-host-cleanup.js";
import { listSessionEntriesCore, patchSessionEntryCore } from "./session-accessor.entry.js";
import { applySessionEntryBatchProjection } from "./session-accessor.sqlite-batch-projection.js";
import "./session-accessor.sqlite-lifecycle.js";
import "./session-accessor.sqlite-projection.js";
import type {
  SessionPatchProjectionSnapshot,
  SessionPatchProjectionTarget,
  SessionPatchProjectionContext,
  SessionPatchProjectionFailure,
  SessionPatchProjectionOperation,
  SessionPatchProjectionResult,
} from "./session-accessor.types.js";
import {
  resolveProjectionExistingEntry,
  SessionLabelOwnerIndex,
} from "./session-entry-selection.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";
export {
  cleanupSessionLifecycleArtifactsCore,
  deleteSessionEntryLifecycle,
  rollbackAgentHarnessSessionEntryLifecycle,
  rollbackPluginOwnedSessionEntryLifecycle,
  resetSessionEntryLifecycle,
} from "./session-accessor.sqlite-lifecycle.js";
export {
  applySessionEntryLifecycleMutation,
  applySessionEntryReplacements,
  applySessionStoreProjection,
  purgeDeletedAgentSessionEntries,
} from "./session-accessor.sqlite-projection.js";

/** Projects ordered session patches against one store snapshot and commits once. */
export async function applySessionPatchProjections<
  TFailure extends SessionPatchProjectionFailure,
>(params: {
  agentId?: string;
  operations: readonly SessionPatchProjectionOperation<TFailure>[];
  sessionKeys?: readonly string[];
  storePath: string;
}): Promise<SessionPatchProjectionResult<TFailure>[]> {
  return await applySessionEntryBatchProjection({
    agentId: params.agentId,
    sessionKeys: params.sessionKeys,
    storePath: params.storePath,
    skipMaintenance: true,
    update: async (workingStore) => {
      const snapshot = { store: workingStore };
      const labelOwners = new SessionLabelOwnerIndex(workingStore);
      const mutations: Array<{
        entry: SessionEntry;
        previousSessionKeys?: readonly string[];
        sessionKey: string;
      }> = [];
      const results: SessionPatchProjectionResult<TFailure>[] = [];
      for (const operation of params.operations) {
        try {
          const target = operation.resolveTarget(snapshot);
          const existingEntry = resolveProjectionExistingEntry(snapshot, target);
          const candidateKeys = uniqueStrings(
            (target.candidateKeys ?? [target.primaryKey]).map((key) => key.trim()).filter(Boolean),
          );
          const projected = await operation.project({
            ...target,
            ...snapshot,
            ...(existingEntry ? { existingEntry } : {}),
            isLabelInUse: (label) => labelOwners.isLabelInUse(label, candidateKeys),
          });
          if (!projected.ok) {
            results.push(projected);
            continue;
          }
          const authorizationFailure = operation.authorize?.();
          if (authorizationFailure) {
            results.push(authorizationFailure);
            continue;
          }
          const previousSessionKeys = candidateKeys.filter(
            (sessionKey) => sessionKey !== target.primaryKey && workingStore[sessionKey],
          );
          mutations.push({
            entry: projected.entry,
            ...(previousSessionKeys.length > 0 ? { previousSessionKeys } : {}),
            sessionKey: target.primaryKey,
          });
          const cloned = labelOwners.replaceEntry(
            candidateKeys,
            target.primaryKey,
            projected.entry,
          );
          results.push({ ok: true, entry: structuredClone(cloned) });
        } catch (error) {
          if (!operation.onError) {
            throw error;
          }
          results.push(operation.onError(error));
        }
      }
      return { mutations, result: results };
    },
  });
}

/** Applies one patch through the canonical ordered batch projection owner. */
export async function applySessionPatchProjection<
  TFailure extends SessionPatchProjectionFailure,
>(params: {
  agentId?: string;
  /** Revalidates request-scoped authorization after the writer slot is held. */
  assertCurrent?: () => void;
  /** Complete key authority for resolvers that can operate on a bounded store view. */
  sessionKeys?: readonly string[];
  storePath: string;
  resolveTarget: (snapshot: SessionPatchProjectionSnapshot) => SessionPatchProjectionTarget;
  project: (
    context: SessionPatchProjectionContext,
  ) => Promise<SessionPatchProjectionResult<TFailure>> | SessionPatchProjectionResult<TFailure>;
}): Promise<SessionPatchProjectionResult<TFailure>> {
  const [result] = await applySessionPatchProjections({
    agentId: params.agentId,
    sessionKeys: params.sessionKeys,
    storePath: params.storePath,
    operations: [
      {
        resolveTarget: params.resolveTarget,
        project: params.project,
        ...(params.assertCurrent
          ? {
              authorize: () => {
                params.assertCurrent?.();
                return undefined;
              },
            }
          : {}),
      },
    ],
  });
  if (!result) {
    throw new Error("Session patch projection produced no result");
  }
  return result;
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
  // Select metadata without yielding; saved prompts are reserved from plugin slots.
  // Check only selected writes; the patch rereads full entries and rechecks authority at commit.
  for (const { entry, sessionKey } of listSessionEntriesCore({
    agentId: params.agentId,
    storePath: params.storePath,
    projection: "list",
  })) {
    if (isLockedHarnessSessionOwnedByPlugin(entry, params.preserveLockedHarnessIds)) {
      continue;
    }
    if (
      !matchesPluginHostCleanupSession(sessionKey, entry, params.sessionKey) ||
      !hasPluginHostCleanupTarget(entry, params)
    ) {
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
        if (!hasPluginHostCleanupTarget(currentEntry, params)) {
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
