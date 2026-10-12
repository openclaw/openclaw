import { AsyncLocalStorage } from "node:async_hooks";
import { scheduler } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { readResolvedSessionEntriesInWorker } from "../../config/sessions/session-accessor.entry.js";
import type { ResolvedSessionEntryAccessTarget } from "../../config/sessions/session-accessor.types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveSessionWorkerPlacementContext,
  type SessionWorkerPlacementContext,
} from "../../gateway/session-worker-placement-context.js";
import { prepareSessionWorkerPlacementMutationCheck } from "../../gateway/worker-environments/session-placement-lifecycle.js";
import {
  isSessionLifecycleMutationActive,
  isSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import {
  sessionChanges,
  sessionChangeScopeAffectsStoredRows,
} from "../../sessions/session-row-changes.js";
import type { WorktreeCleanupOwnerPolicy } from "./gc-removal.js";
import { WorktreeRemovalLockError } from "./removal-errors.js";
import { IDLE_GC_MS } from "./service.js";
import type { ManagedWorktreeOwnerKind } from "./types.js";

export function createManagedWorktreeOwnerPolicy(
  cfg: OpenClawConfig,
  now: () => number = Date.now,
): Required<
  Pick<WorktreeCleanupOwnerPolicy, "prepareOwners" | "readOwnerState" | "withOwnerCleanup">
> {
  const placementChecks = new Map<string, { sessionId?: string; assertCurrent: () => void }>();
  let preparedOwners = new Map<string, ResolvedSessionEntryAccessTarget>();
  const cleanupOwner = new AsyncLocalStorage<{
    ownerId: string;
    scope: string;
    entry?: Pick<SessionEntry, "sessionId" | "lifecycleRevision" | "archivedAt" | "worktree">;
    target: ResolvedSessionEntryAccessTarget;
    hasChanged: () => boolean;
    lifecycleHeld?: boolean;
  }>();
  const state = (
    ownerKind: ManagedWorktreeOwnerKind,
    ownerId: string,
    prepared?: {
      target: ResolvedSessionEntryAccessTarget;
      context: SessionWorkerPlacementContext;
      checks: typeof placementChecks;
    },
  ) => {
    if (ownerKind !== "session") {
      return "other";
    }
    try {
      const cleanup = cleanupOwner.getStore();
      const ownsCleanup = cleanup?.ownerId === ownerId;
      const target = prepared?.target ?? (ownsCleanup ? cleanup.target : undefined);
      // Outside a prepared census or cleanup lifetime there are no current owner facts.
      if (!target || (ownsCleanup && cleanup.hasChanged())) {
        return "active";
      }
      const entry = target.entry;
      const activityAt = Math.max(entry?.lastInteractionAt ?? 0, entry?.updatedAt ?? 0);
      if (entry?.archivedAt === undefined && activityAt > 0 && now() - activityAt <= IDLE_GC_MS) {
        return "active";
      }
      const scope = resolveSessionStorePathCore(cfg.session?.store, { agentId: target.agentId });
      const identities = [target.canonicalKey, ownerId, entry?.sessionId];
      if (
        ownsCleanup &&
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
        (!(ownsCleanup && cleanup.lifecycleHeld) &&
          isSessionLifecycleMutationActive(scope, identities))
      ) {
        return "active";
      }
      const placementCheckCache = prepared?.checks ?? placementChecks;
      let placementCheck = placementCheckCache.get(target.canonicalKey);
      if (placementCheck && placementCheck.sessionId !== entry?.sessionId) {
        return "active";
      }
      if (!placementCheck) {
        const context = prepared?.context ?? resolveSessionWorkerPlacementContext();
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
        placementCheckCache.set(target.canonicalKey, placementCheck);
      }
      placementCheck.assertCurrent();
      return !entry || entry.archivedAt !== undefined ? "retired" : "idle";
    } catch {
      // GC is destructive. Unknown session state must defer cleanup instead of
      // turning a transient owner lookup failure into worktree removal.
      return "active";
    }
  };
  // Census facts are advisory; cleanup reads once and invalidates on committed owner changes.
  return {
    prepareOwners: async (records) => {
      preparedOwners = new Map();
      const ownerIds = [
        ...new Set(
          records.flatMap((record) =>
            record.removedAt === undefined && record.ownerKind === "session" && record.ownerId
              ? [record.ownerId]
              : [],
          ),
        ),
      ];
      const states = new Map<string, ReturnType<typeof state>>();
      try {
        const context = resolveSessionWorkerPlacementContext();
        if (!context.workerSessionPlacementService?.listAsync) {
          throw new Error("Worker placement census is unavailable");
        }
        const [targets, placements] = await Promise.all([
          readResolvedSessionEntriesInWorker({ cfg, sessionKeys: ownerIds }, "worktree"),
          context.workerSessionPlacementService.listAsync(),
        ]);
        preparedOwners = targets;
        const byId = new Map(placements.map((placement) => [placement.sessionId, placement]));
        const byKey = new Map<string, typeof placements>();
        for (const placement of placements) {
          if (placement.state !== "local" && placement.state !== "reclaimed") {
            const related = byKey.get(placement.sessionKey) ?? [];
            related.push(placement);
            byKey.set(placement.sessionKey, related);
          }
        }
        // Advisory facts never escape into the exact pre-mutation placement guards.
        const prepared = {
          checks: new Map<string, { sessionId?: string; assertCurrent: () => void }>(),
          context: {
            ...context,
            workerSessionPlacementService: {
              getMany: () => byId,
              listForReconcile: (key?: string) => byKey.get(key ?? "") ?? [],
            },
          },
        };
        for (const [index, id] of ownerIds.entries()) {
          if (index % 32 === 0) {
            await scheduler.yield();
          }
          const target = targets.get(id);
          states.set(id, target ? state("session", id, { ...prepared, target }) : "active");
        }
      } catch {
        // A failed census supplies no authority to remove a session-owned checkout.
      }
      return {
        readOwnerState: (kind, id) => (kind === "session" ? (states.get(id) ?? "active") : "other"),
      };
    },
    readOwnerState: (kind, id) => state(kind, id),
    withOwnerCleanup: async (record, run, signal) => {
      if (record.ownerKind !== "session" || !record.ownerId) {
        return await run((mutation) => mutation());
      }
      const ownerId = record.ownerId;
      const expected = preparedOwners.get(ownerId);
      let target = expected;
      let changed = false;
      const stop = sessionChanges.subscribeFacts((change) => {
        if (
          sessionChangeScopeAffectsStoredRows(change) &&
          ("all" in change ||
            !target ||
            change.sessionKey === ownerId ||
            change.sessionKey === target.canonicalKey)
        ) {
          changed = true;
        }
      });
      try {
        target = (
          await readResolvedSessionEntriesInWorker({ cfg, sessionKeys: [ownerId] }, "worktree")
        ).get(ownerId);
        signal?.throwIfAborted();
        if (!target) {
          throw new WorktreeRemovalLockError(
            "busy",
            "worktree owner could not be read for cleanup",
          );
        }
        const initial = expected ?? target;
        const scope = resolveSessionStorePathCore(cfg.session?.store, { agentId: initial.agentId });
        const entry = initial.entry;
        const owner = {
          ownerId,
          scope,
          target,
          hasChanged: () => changed,
          entry: entry && { ...entry, worktree: entry.worktree && { ...entry.worktree } },
        };
        const identities = [target.canonicalKey, ownerId, owner.entry?.sessionId];
        // The registry claim protects Git work; final guards consume this receipt-invalidated view.
        return await cleanupOwner.run(owner, () =>
          run((mutation, options) =>
            runExclusiveSessionLifecycleMutation("worktree-cleanup", {
              scope,
              identities,
              signal: options?.settle ? undefined : signal,
              run: () => cleanupOwner.run({ ...owner, lifecycleHeld: true }, mutation),
            }),
          ),
        );
      } finally {
        stop();
      }
    },
  };
}
