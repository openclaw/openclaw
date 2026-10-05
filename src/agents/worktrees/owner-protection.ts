import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { resolveSessionEntryAccessTarget } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSessionWorkerPlacementContext } from "../../gateway/session-worker-placement-context.js";
import { prepareSessionWorkerPlacementMutationCheck } from "../../gateway/worker-environments/session-placement-lifecycle.js";
import {
  isSessionLifecycleMutationActive,
  isSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import type { WorktreeCleanupOwnerPolicy } from "./gc-removal.js";
import { IDLE_GC_MS } from "./service.js";
import type { ManagedWorktreeOwnerKind } from "./types.js";

export function createManagedWorktreeOwnerPolicy(
  cfg: OpenClawConfig,
  now: () => number = Date.now,
): Required<
  Pick<WorktreeCleanupOwnerPolicy, "shouldProtectOwner" | "shouldRemoveOwner" | "withOwnerCleanup">
> {
  const placementChecks = new Map<string, { sessionId?: string; assertCurrent: () => void }>();
  const cleanupOwner = new AsyncLocalStorage<{
    ownerId: string;
    scope: string;
    entry?: SessionEntry;
  }>();
  const state = (ownerKind: ManagedWorktreeOwnerKind, ownerId: string) => {
    if (ownerKind !== "session") {
      return "other";
    }
    try {
      const target = resolveSessionEntryAccessTarget({ cfg, sessionKey: ownerId });
      const entry = target.entry;
      const scope = resolveSessionStorePathCore(cfg.session?.store, { agentId: target.agentId });
      const identities = [target.canonicalKey, ownerId, entry?.sessionId];
      const cleanup = cleanupOwner.getStore();
      const ownsLifecycle = cleanup?.ownerId === ownerId;
      if (
        ownsLifecycle &&
        (cleanup.scope !== scope ||
          cleanup.entry?.sessionId !== entry?.sessionId ||
          cleanup.entry?.lifecycleRevision !== entry?.lifecycleRevision ||
          cleanup.entry?.archivedAt !== entry?.archivedAt ||
          !isDeepStrictEqual(cleanup.entry?.worktree, entry?.worktree))
      ) {
        return "active";
      }
      if (
        isSessionWorkAdmissionActive(scope, identities) ||
        (!ownsLifecycle && isSessionLifecycleMutationActive(scope, identities))
      ) {
        return "active";
      }
      let placementCheck = placementChecks.get(target.canonicalKey);
      if (placementCheck && placementCheck.sessionId !== entry?.sessionId) {
        return "active";
      }
      if (!placementCheck) {
        const context = resolveSessionWorkerPlacementContext();
        const store = context.workerSessionPlacementService;
        if (!store?.listForReconcile) {
          return "active";
        }
        // Missing session metadata cannot erase a durable remote worker's ownership.
        const related = () =>
          store.listForReconcile!(target.canonicalKey)
            .map((placement) => placement.sessionId)
            .toSorted();
        const initial = related();
        const checks = [
          ...new Set([...initial, ...(entry?.sessionId ? [entry.sessionId] : [])]),
        ].map((sessionId) => prepareSessionWorkerPlacementMutationCheck({ context, sessionId }));
        const assertCurrent = () => {
          if (JSON.stringify(related()) !== JSON.stringify(initial)) {
            throw new Error("worktree worker placement changed during cleanup");
          }
          for (const check of checks) {
            check();
          }
        };
        placementCheck = { sessionId: entry?.sessionId, assertCurrent };
        placementChecks.set(target.canonicalKey, placementCheck);
      }
      placementCheck.assertCurrent();
      if (!entry || entry.archivedAt !== undefined) {
        return "retired";
      }
      const activityAt = Math.max(entry?.lastInteractionAt ?? 0, entry?.updatedAt ?? 0);
      return activityAt > 0 && now() - activityAt <= IDLE_GC_MS ? "active" : "idle";
    } catch {
      // GC is destructive. Unknown session state must defer cleanup instead of
      // turning a transient owner lookup failure into worktree removal.
      return "active";
    }
  };
  // Re-read at each mutation guard: an unarchive or new turn can invalidate an earlier cleanup decision.
  return {
    shouldProtectOwner: (kind, id) => state(kind, id) === "active",
    shouldRemoveOwner: (kind, id) => state(kind, id) === "retired",
    withOwnerCleanup: async (record, run, signal) => {
      if (record.ownerKind !== "session" || !record.ownerId) {
        return await run();
      }
      const ownerId = record.ownerId;
      const target = resolveSessionEntryAccessTarget({ cfg, sessionKey: ownerId });
      const scope = resolveSessionStorePathCore(cfg.session?.store, { agentId: target.agentId });
      // Unarchive must observe either the retained checkout or its finalized snapshot.
      // This fences only its session; no session-store writer remains held during Git work.
      return await runExclusiveSessionLifecycleMutation("worktree-cleanup", {
        scope,
        identities: [target.canonicalKey, ownerId, target.entry?.sessionId],
        signal,
        run: () => cleanupOwner.run({ ownerId, scope, entry: target.entry }, run),
      });
    },
  };
}
