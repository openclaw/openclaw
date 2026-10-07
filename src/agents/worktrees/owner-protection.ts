import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  readResolvedSessionEntriesInWorker,
  resolveSessionEntryAccessTarget,
} from "../../config/sessions/session-accessor.entry.js";
import type { ResolvedSessionEntryAccessTarget } from "../../config/sessions/session-accessor.types.js";
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
  Pick<
    WorktreeCleanupOwnerPolicy,
    "prepareOwners" | "shouldProtectOwner" | "shouldRemoveOwner" | "withOwnerCleanup"
  >
> {
  const placementChecks = new Map<string, { sessionId?: string; assertCurrent: () => void }>();
  const cleanupOwner = new AsyncLocalStorage<{
    ownerId: string;
    scope: string;
    entry?: Pick<SessionEntry, "sessionId" | "lifecycleRevision" | "archivedAt" | "worktree">;
    lifecycleHeld?: boolean;
  }>();
  const state = (
    ownerKind: ManagedWorktreeOwnerKind,
    ownerId: string,
    prepared?: ResolvedSessionEntryAccessTarget,
  ) => {
    if (ownerKind !== "session") {
      return "other";
    }
    try {
      const target =
        prepared ??
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
      return !entry || entry.archivedAt !== undefined ? "retired" : "idle";
    } catch {
      // GC is destructive. Unknown session state must defer cleanup instead of
      // turning a transient owner lookup failure into worktree removal.
      return "active";
    }
  };
  // Census facts live for one pass; synchronous mutation guards always reread the narrow row.
  return {
    prepareOwners: async (records) => {
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
        const targets = await readResolvedSessionEntriesInWorker(
          { cfg, sessionKeys: ownerIds },
          "worktree",
        );
        for (const id of ownerIds) {
          states.set(id, state("session", id, targets.get(id)));
        }
      } catch {
        // A failed census supplies no authority to remove a session-owned checkout.
      }
      return {
        shouldProtectOwner: (kind, id) =>
          kind === "session" && (states.get(id) ?? "active") === "active",
        shouldRemoveOwner: (kind, id) => kind === "session" && states.get(id) === "retired",
      };
    },
    shouldProtectOwner: (kind, id) => state(kind, id) === "active",
    shouldRemoveOwner: (kind, id) => state(kind, id) === "retired",
    withOwnerCleanup: async (record, run, signal) => {
      if (record.ownerKind !== "session" || !record.ownerId) {
        return await run((mutation) => mutation());
      }
      const ownerId = record.ownerId;
      const target = resolveSessionEntryAccessTarget(
        { cfg, sessionKey: ownerId },
        { projection: "worktree" },
      );
      const scope = resolveSessionStorePathCore(cfg.session?.store, { agentId: target.agentId });
      const entry = target.entry;
      const owner = {
        ownerId,
        scope,
        entry: entry && { ...entry, worktree: entry.worktree && { ...entry.worktree } },
      };
      const identities = [target.canonicalKey, ownerId, owner.entry?.sessionId];
      // The registry removal claim fences checkout consumers during Git work.
      // Session admission is held only while claiming and publishing that lifecycle.
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
    },
  };
}
