import { AsyncLocalStorage } from "node:async_hooks";
import { scheduler } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  readResolvedSessionEntriesInWorker,
  resolveSessionEntryAccessTarget,
} from "../../config/sessions/session-accessor.entry.js";
import type { ResolvedSessionEntryAccessTarget } from "../../config/sessions/session-accessor.types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveSessionWorkerPlacementContext,
  type SessionWorkerPlacementContext,
} from "../../gateway/session-worker-placement-context.js";
import type { WorkerSessionPlacementRecord } from "../../gateway/worker-environments/placement-record.js";
import { resolveSessionWorkerPlacementMutationError } from "../../gateway/worker-environments/session-placement-lifecycle.js";
import {
  isSessionLifecycleMutationActive,
  isSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
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
  type PlacementFacts = {
    context: SessionWorkerPlacementContext;
    current: () => readonly WorkerSessionPlacementRecord[];
  };
  let preparedOwners = new Map<string, ResolvedSessionEntryAccessTarget>();
  const cleanupOwner = new AsyncLocalStorage<{
    ownerId: string;
    scope: string;
    entry?: Pick<SessionEntry, "sessionId" | "lifecycleRevision" | "archivedAt" | "worktree">;
    lifecycleHeld?: boolean;
    placements: PlacementFacts;
  }>();
  const state = (
    ownerKind: ManagedWorktreeOwnerKind,
    ownerId: string,
    prepared?: {
      target: ResolvedSessionEntryAccessTarget;
      placements: PlacementFacts;
    },
  ) => {
    if (ownerKind !== "session") {
      return "other";
    }
    try {
      const target =
        prepared?.target ??
        resolveSessionEntryAccessTarget({ cfg, sessionKey: ownerId }, { projection: "worktree" });
      const entry = target.entry;
      const activityAt = Math.max(entry?.lastInteractionAt ?? 0, entry?.updatedAt ?? 0);
      if (entry?.archivedAt === undefined && activityAt > 0 && now() - activityAt <= IDLE_GC_MS) {
        return "active";
      }
      const scope = resolveSessionStorePathCore(cfg.session?.store, { agentId: target.agentId });
      const identities = [target.canonicalKey, ownerId, entry?.sessionId];
      const cleanup = cleanupOwner.getStore();
      const ownsCleanup = cleanup?.ownerId === ownerId;
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
      const placements = prepared?.placements ?? (ownsCleanup ? cleanup.placements : undefined);
      if (!placements) {
        return "active";
      }
      // Missing session metadata cannot erase a durable remote worker's ownership.
      for (const placement of placements.current()) {
        if (
          placement.sessionKey !== target.canonicalKey &&
          placement.sessionId !== entry?.sessionId
        ) {
          continue;
        }
        if (
          placement.turnClaim ||
          resolveSessionWorkerPlacementMutationError({
            action: "fork",
            context: {
              ...placements.context,
              workerSessionPlacementService: {
                getMany: () => new Map([[placement.sessionId, placement]]),
              },
            },
            key: target.canonicalKey,
            sessionId: placement.sessionId,
          })
        ) {
          return "active";
        }
      }
      return !entry || entry.archivedAt !== undefined ? "retired" : "idle";
    } catch {
      // GC is destructive. Unknown session state must defer cleanup instead of
      // turning a transient owner lookup failure into worktree removal.
      return "active";
    }
  };
  // Census facts are advisory; cleanup retains worker facts until the guarded mutation ends.
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
        const prepared = {
          placements: { context, current: () => placements },
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
      const target =
        preparedOwners.get(ownerId) ??
        (await readResolvedSessionEntriesInWorker({ cfg, sessionKeys: [ownerId] }, "worktree")).get(
          ownerId,
        );
      signal?.throwIfAborted();
      if (!target) {
        throw new WorktreeRemovalLockError("busy", "worktree owner could not be read for cleanup");
      }
      const scope = resolveSessionStorePathCore(cfg.session?.store, { agentId: target.agentId });
      const entry = target.entry;
      const owner = {
        ownerId,
        scope,
        entry: entry && { ...entry, worktree: entry.worktree && { ...entry.worktree } },
      };
      const identities = [target.canonicalKey, ownerId, owner.entry?.sessionId];
      const context = resolveSessionWorkerPlacementContext();
      const store = context.workerSessionPlacementService;
      if (!store?.prepareMaintenancePlacements || !store.prepareSessionPlacement) {
        throw new WorktreeRemovalLockError("busy", "worker placement preparation is unavailable");
      }
      const inventory = await store.prepareMaintenancePlacements();
      let sessionPlacement: Awaited<ReturnType<typeof store.prepareSessionPlacement>> | undefined;
      try {
        if (entry?.sessionId) {
          sessionPlacement = await store.prepareSessionPlacement(entry.sessionId);
        }
        const placements: PlacementFacts = {
          context,
          current: () => {
            inventory.assertCurrent();
            const current = sessionPlacement?.current();
            return current ? [...inventory.placements, current] : inventory.placements;
          },
        };
        // The registry removal claim fences checkout consumers during Git work.
        // Session admission is held only while claiming and publishing that lifecycle.
        return await cleanupOwner.run({ ...owner, placements }, () =>
          run((mutation, options) =>
            runExclusiveSessionLifecycleMutation("worktree-cleanup", {
              scope,
              identities,
              signal: options?.settle ? undefined : signal,
              run: () => cleanupOwner.run({ ...owner, placements, lifecycleHeld: true }, mutation),
            }),
          ),
        );
      } finally {
        sessionPlacement?.release();
        inventory.release();
      }
    },
  };
}
