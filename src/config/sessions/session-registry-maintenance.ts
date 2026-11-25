// Storage-neutral session registry maintenance for cron run cleanup.
import fs from "node:fs";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import {
  sessionChanges,
  sessionChangeScopeAffectsStoredRows,
} from "../../sessions/session-row-changes.js";
import {
  applySessionEntryLifecycleMutation,
  type SessionEntryLifecycleRemoval,
  type SessionEntrySummary,
} from "./session-accessor.js";
import { listSessionChildEntriesReadOnly } from "./session-entry-children-read.js";
import { withSessionRegistryEntriesInWorker } from "./session-entry-read-maintenance.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { collectActiveSessionWorkAdmissionKeys } from "./store-maintenance-preserve.js";
import { pruneStaleEntries, shouldPreserveMaintenanceEntry } from "./store-maintenance.js";
import type { SessionStoreTarget } from "./targets.js";
import type { SessionEntry } from "./types.js";

type SessionRegistryMaintenanceStoreSummary = {
  preservedRunning: number;
  pruned: number;
  nextSweepAtMs: number | null;
};

type SessionRegistryMaintenanceStoreOptions = SessionStoreTarget & {
  /** Whether to commit the selected removals to the backing store. */
  apply: boolean;
  /** Retention window for cron-run session entries. */
  retentionMs: number;
  /** Currently running cron job ids, normalized to lowercase. */
  runningCronJobIds: ReadonlySet<string>;
  /** All discovered stores, including children spawned into another agent. */
  childStores?: readonly SessionStoreTarget[];
  assertCurrent?: () => void;
};

async function pruneSessionRegistryStore(
  params: SessionRegistryMaintenanceStoreOptions & { store: Record<string, SessionEntry> },
) {
  const { store, storePath, agentId } = params;
  const preserveKeys =
    collectActiveSessionWorkAdmissionKeys({ storePath, store }) ?? new Set<string>();
  let preservedRunning = 0;
  for (const key of Object.keys(store)) {
    const parsed = parseAgentSessionKey(key);
    const jobId = /^cron:([^:]+):run:[^:]+(?:$|:)/u.exec(parsed?.rest ?? "")?.[1];
    if (jobId && params.runningCronJobIds.has(jobId)) {
      preserveKeys.add(key);
      preservedRunning += 1;
    }
  }
  const candidates: SessionEntrySummary[] = [];
  pruneStaleEntries(store, params.retentionMs, {
    log: false,
    onPruned: ({ key, entry }) => candidates.push({ sessionKey: key, entry }),
    preserveKeys,
  });
  const pending = candidates.map(({ sessionKey }) => sessionKey);
  const seen = new Set(pending);
  const parents = new Map<string, string>();
  for (let offset = 0; offset < pending.length;) {
    const keys = pending.slice(offset, offset + 32);
    offset += keys.length;
    for (const target of params.childStores ?? [{ agentId, storePath }]) {
      const children = await listSessionChildEntriesReadOnly(
        { ...target, sessionKey: "", projection: "list" },
        keys,
      );
      params.assertCurrent?.();
      // Lookup excludes its input keys, so include links among the candidates too.
      for (const { sessionKey, entry } of [...candidates, ...children]) {
        const parent = entry.spawnedBy;
        if (!parent || !keys.includes(parent)) {
          continue;
        }
        parents.set(sessionKey, parent);
        if (entry.archivedAt === undefined) {
          preserveKeys.add(parent);
        } else if (!seen.has(sessionKey)) {
          seen.add(sessionKey);
          pending.push(sessionKey);
        }
      }
    }
  }
  // Admission follows archived intermediates; retain every ancestor of a live descendant.
  for (const key of preserveKeys) {
    const parent = parents.get(key);
    if (parent) {
      preserveKeys.add(parent);
    }
  }
  const removals: SessionEntryLifecycleRemoval[] = [];
  for (const { sessionKey, entry } of candidates) {
    if (preserveKeys.has(sessionKey)) {
      store[sessionKey] = entry;
    } else {
      removals.push({ sessionKey, expectedEntry: entry, archiveRemovedTranscript: true });
    }
  }
  const now = Date.now();
  let nextSweepAtMs: number | null = null;
  for (const [key, entry] of Object.entries(store)) {
    if (
      shouldPreserveMaintenanceEntry({ key, entry }) ||
      typeof entry.updatedAt !== "number" ||
      !Number.isFinite(entry.updatedAt)
    ) {
      continue;
    }
    // Expired protected rows retry after running work or child dependencies settle.
    const expiresAt = entry.updatedAt + params.retentionMs + 1;
    const deadline = expiresAt <= now ? now + 60_000 : expiresAt;
    nextSweepAtMs = Math.min(nextSweepAtMs ?? Infinity, deadline);
  }
  return { preservedRunning, pruned: removals.length, nextSweepAtMs, removals };
}

/**
 * Runs session-registry maintenance for one resolved agent store.
 * Preview and apply consume bounded snapshots under one physical reader owner.
 * The lifecycle owner commits removals without running generic session maintenance.
 */
export async function runSessionRegistryMaintenanceForStore(
  params: SessionRegistryMaintenanceStoreOptions,
): Promise<SessionRegistryMaintenanceStoreSummary> {
  params.assertCurrent?.();
  const { agentId, storePath } = params;
  const summary: SessionRegistryMaintenanceStoreSummary = {
    preservedRunning: 0,
    pruned: 0,
    nextSweepAtMs: null,
  };
  const sqliteTarget = resolveSqliteTargetFromSessionStorePath(storePath, { agentId });
  if (sqliteTarget.path && !fs.existsSync(sqliteTarget.path)) {
    return summary;
  }
  let rowRevision = 0;
  const unsubscribe = sessionChanges.subscribeFacts((change) => {
    if (
      sessionChangeScopeAffectsStoredRows(change) &&
      ("all" in change ||
        change.factsInvalidated === true ||
        change.facts?.kind === "entry" ||
        change.facts?.kind === "replacement" ||
        change.facts?.kind === "removed")
    ) {
      rowRevision += 1;
    }
  });
  try {
    await withSessionRegistryEntriesInWorker(
      { agentId, storePath },
      async (entries, assertReaderCurrent) => {
        const assertCurrent = () => {
          params.assertCurrent?.();
          assertReaderCurrent();
        };
        assertCurrent();
        const store = Object.fromEntries(
          entries.map(({ sessionKey, entry }) => [sessionKey, entry]),
        );
        const revision = rowRevision;
        const planned = await pruneSessionRegistryStore({ ...params, store, assertCurrent });
        const { removals, preservedRunning } = planned;
        let { pruned, nextSweepAtMs } = planned;
        if (params.apply && removals.length > 0) {
          const mutation = await applySessionEntryLifecycleMutation({
            agentId,
            storePath,
            removals,
            skipMaintenance: true,
            commitGuard() {
              assertCurrent();
              // Child creation/restoration and store discovery must still match the read.
              if (rowRevision !== revision) {
                throw new Error("Session ancestry changed before cron registry cleanup");
              }
            },
          });
          assertCurrent();
          if (mutation.removedEntries !== pruned) {
            nextSweepAtMs = Date.now() + 60_000;
          }
          pruned = mutation.removedEntries;
        }
        summary.preservedRunning += preservedRunning;
        summary.pruned += pruned;
        if (nextSweepAtMs !== null) {
          summary.nextSweepAtMs = Math.min(summary.nextSweepAtMs ?? Infinity, nextSweepAtMs);
        }
      },
    );
    return summary;
  } finally {
    unsubscribe();
  }
}
