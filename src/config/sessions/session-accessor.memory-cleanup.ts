import type { SessionEntryLifecycleMutationResult } from "./session-accessor.lifecycle-types.js";
import { withSqliteSessionDeletions } from "./session-accessor.sqlite-deletion.js";
import type { SessionEntryLifecycleMutationParams } from "./session-accessor.sqlite-lifecycle-types.js";
import { resolveSqliteSessionKey } from "./session-accessor.sqlite-scope-helpers.js";
import type { ResolvedSqliteReadScope } from "./session-accessor.sqlite-scope.js";
import type { SessionActorMemoryEntryWrites } from "./session-actor-memory-entry-contract.js";
import { captureSessionActorStorageOwner } from "./session-actor-storage-binding.js";
import { readSessionActorStorageResult } from "./session-actor-storage-result.js";
import { shouldRemoveSessionEntry } from "./session-entry-lifecycle-removal.js";
import { planSessionEntryMaintenance } from "./store-maintenance-plan.js";
import { resolveSessionMaintenancePreserveKeys } from "./store-maintenance-preserve-snapshot.js";
import { prepareSessionMaintenancePreservation } from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import {
  countUnarchivedSessionEntries,
  normalizeResolvedMaintenanceConfigInput,
} from "./store-maintenance.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

type ReclaimInput = SessionActorMemoryEntryWrites["session.lifecycle.reclaim"]["input"];

/** Incognito bulk cleanup retains the same actor and companion-deletion owners as single deletes. */
export function applyMemorySessionEntryCleanup(
  params: SessionEntryLifecycleMutationParams,
  resolved: ResolvedSqliteReadScope & { env: NodeJS.ProcessEnv; path: string },
): Promise<SessionEntryLifecycleMutationResult> | undefined {
  const assertCurrent = () => params.commitGuard?.();
  const captured = captureSessionActorStorageOwner(
    { ...resolved, storePath: resolved.path },
    { assertCurrent, authorize: assertCurrent },
  );
  if (!captured) {
    return undefined;
  }
  return (async () => {
    if (
      [...(params.upserts ?? [])].length ||
      params.allowCanonicalRepair ||
      params.afterUpsertsInTransaction ||
      params.afterFreshUpsertsInTransaction
    ) {
      throw new Error("Memory bulk cleanup does not support SQLite repair or upsert callbacks");
    }
    // cleanupArchivedTranscripts owns published disk archives. Removing a memory entry
    // already discards its retained windows; archiving an entry preserves them.
    const empty: SessionEntryLifecycleMutationResult = {
      beforeCount: 0,
      removedEntries: 0,
      removedSessionKeys: [],
      archived: 0,
      capArchived: 0,
      modelRunPruned: 0,
      pruned: 0,
      capped: 0,
      archivedTranscriptDirectories: [],
      afterCount: 0,
    };
    const owner = captured.owner;
    const entries = owner?.listSessionEntries(captured.authority) ?? [];
    if (!owner || !entries.length) {
      return empty;
    }
    const actor = await owner.acquireExisting(entries[0]!.sessionKey, {
      assertCurrent: () => captured.authority.assertCurrent(),
      assertReadable: () => captured.authority.assertCurrent(),
    });
    if (!actor) {
      return empty;
    }
    let preservation: Awaited<ReturnType<typeof prepareSessionMaintenancePreservation>> | undefined;
    try {
      preservation = params.skipMaintenance
        ? undefined
        : await prepareSessionMaintenancePreservation(params.storePath);
      const beforeStore = Object.fromEntries(
        entries.map(({ sessionKey, entry }) => [sessionKey, entry]),
      );
      const store: Record<string, SessionEntry> = structuredClone(beforeStore);
      const removals: ReclaimInput["entries"][number][] = [];
      const explicitKeys = new Set<string>();
      const removalReasons = new Map<string, "model-run-pruned" | "pruned" | "capped">();
      const archives: NonNullable<ReclaimInput["archives"]>[number][] = [];
      const capArchives = new Set<string>();
      for (const removal of params.removals ?? []) {
        const sessionKey = resolveSqliteSessionKey(removal.sessionKey, captured.agentId);
        const entry = store[sessionKey];
        if (shouldRemoveSessionEntry(entry, removal)) {
          explicitKeys.add(sessionKey);
          removals.push({
            sessionKey,
            expected: beforeStore[sessionKey]!,
            requiresMissingTranscript: removal.requiresMissingTranscript,
          });
          delete store[sessionKey];
        }
      }
      const maintenance = normalizeResolvedMaintenanceConfigInput({
        ...resolveMaintenanceConfig(),
        ...params.maintenanceOverride,
      });
      if (preservation && maintenance.mode !== "warn") {
        const snapshot = preservation.capture();
        planSessionEntryMaintenance({
          maintenance,
          initialUnarchivedCount: countUnarchivedSessionEntries(store),
          forceMaintenance: params.maintenanceOverride !== undefined,
          readPreserveKeys: () =>
            resolveSessionMaintenancePreserveKeys({
              store,
              snapshot,
              baseKeys: [params.activeSessionKey],
            }),
          readAgeCandidates: () => store,
          readCapCandidates: () => ({ store, maxEntries: maintenance.maxEntries }),
          onArchived: ({ key, entry }, phase) => {
            archives.push({ sessionKey: key, expected: beforeStore[key]!, entry });
            if (phase === "cap") {
              capArchives.add(key);
            }
          },
          onRemoved: ({ key }, reason) => {
            removals.push({ sessionKey: key, expected: beforeStore[key]! });
            removalReasons.set(key, reason);
          },
        });
      }
      const deletedEntries = removals.map(({ sessionKey, expected: entry }) => ({
        sessionKey,
        entry,
      }));
      const commit = async (assertSourceCurrent: () => void) =>
        withSqliteSessionDeletions(
          resolved,
          deletedEntries,
          async (assertDeletionCurrent, capture) => {
            let settlement: ReturnType<typeof capture> | undefined;
            const outcome = await actor.storage!.mutate(
              { type: "session.lifecycle.reclaim", input: { entries: removals, archives } },
              {
                authorize: (...args) => captured.authority.authorize(...args),
                assertCurrent() {
                  captured.authority.assertCurrent();
                  assertSourceCurrent();
                  assertDeletionCurrent();
                },
              },
              {
                beforeCommit(receipt) {
                  params.beforeCommitInTransaction?.();
                  const removed = new Set(receipt.value.removedSessionKeys);
                  settlement = capture(
                    deletedEntries.filter(({ sessionKey }) => removed.has(sessionKey)),
                  );
                  settlement.beforeCommit();
                },
              },
            );
            settlement?.settle(outcome.kind);
            if (outcome.kind === "committed") {
              params.onLifecycleCommitted?.();
            }
            return readSessionActorStorageResult(outcome);
          },
          { memory: owner },
        );
      const committed = params.withCommit
        ? await params.withCommit(commit)
        : await commit(() => {});
      await params.afterCommitted?.({
        env: resolved.env,
        assertCurrent: () => owner.assertCurrent(),
      });
      const removedSessionKeys = committed.removedSessionKeys.filter((key) =>
        explicitKeys.has(key),
      );
      const capArchived = committed.archivedSessionKeys.filter((key) =>
        capArchives.has(key),
      ).length;
      return {
        ...empty,
        beforeCount: committed.beforeCount,
        afterCount: committed.afterCount,
        removedSessionKeys,
        removedEntries: removedSessionKeys.length,
        archived: committed.archivedSessionKeys.length,
        capArchived,
        modelRunPruned: committed.removedSessionKeys.filter(
          (key) => removalReasons.get(key) === "model-run-pruned",
        ).length,
        pruned: committed.removedSessionKeys.filter((key) => removalReasons.get(key) === "pruned")
          .length,
        capped:
          capArchived +
          committed.removedSessionKeys.filter((key) => removalReasons.get(key) === "capped").length,
      };
    } finally {
      preservation?.dispose();
      await actor.release();
    }
  })();
}
