// Storage-neutral session registry maintenance for cron run cleanup.
import fs from "node:fs";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import {
  applySessionEntryLifecycleMutation,
  type SessionEntryLifecycleRemoval,
} from "./session-accessor.js";
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
  assertCurrent?: () => void;
};

function parseCronRunSessionJobId(sessionKey: string): string | undefined {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return undefined;
  }
  return /^cron:([^:]+):run:[^:]+(?:$|:)/u.exec(parsed.rest)?.[1];
}

function buildSessionRegistryPreserveKeys(params: {
  runningCronJobIds: ReadonlySet<string>;
  storePath: string;
  store: Record<string, SessionEntry>;
}): { preserveKeys: Set<string>; preservedRunning: number } {
  const preserveKeys =
    collectActiveSessionWorkAdmissionKeys({
      storePath: params.storePath,
      store: params.store,
    }) ?? new Set<string>();
  let preservedRunning = 0;
  for (const key of Object.keys(params.store)) {
    const jobId = parseCronRunSessionJobId(key);
    if (jobId && params.runningCronJobIds.has(jobId)) {
      preserveKeys.add(key);
      preservedRunning += 1;
    }
  }
  return { preserveKeys, preservedRunning };
}

function pruneSessionRegistryStore(params: {
  retentionMs: number;
  removals?: SessionEntryLifecycleRemoval[];
  runningCronJobIds: ReadonlySet<string>;
  storePath: string;
  store: Record<string, SessionEntry>;
}): SessionRegistryMaintenanceStoreSummary {
  const { preserveKeys, preservedRunning } = buildSessionRegistryPreserveKeys({
    runningCronJobIds: params.runningCronJobIds,
    storePath: params.storePath,
    store: params.store,
  });
  const pruned = pruneStaleEntries(params.store, params.retentionMs, {
    log: false,
    onPruned: params.removals
      ? ({ key, entry }) => {
          params.removals?.push({
            sessionKey: key,
            expectedEntry: entry,
            archiveRemovedTranscript: true,
          });
        }
      : undefined,
    preserveKeys,
  });
  const now = Date.now();
  let nextSweepAtMs: number | null = null;
  for (const [key, entry] of Object.entries(params.store)) {
    if (
      shouldPreserveMaintenanceEntry({ key, entry }) ||
      typeof entry.updatedAt !== "number" ||
      !Number.isFinite(entry.updatedAt)
    ) {
      continue;
    }
    // Expired active rows retry after their running job or session admission settles.
    const expiresAt = entry.updatedAt + params.retentionMs + 1;
    const deadline = expiresAt <= now ? now + 60_000 : expiresAt;
    nextSweepAtMs = Math.min(nextSweepAtMs ?? Infinity, deadline);
  }
  return {
    preservedRunning,
    pruned,
    nextSweepAtMs,
  };
}

/**
 * Runs session-registry maintenance for one resolved agent store.
 * Preview and apply select removals from one owned worker snapshot.
 * The lifecycle owner commits removals without running generic session maintenance.
 */
export async function runSessionRegistryMaintenanceForStore(
  params: SessionRegistryMaintenanceStoreOptions,
): Promise<SessionRegistryMaintenanceStoreSummary> {
  params.assertCurrent?.();
  const { agentId, storePath } = params;
  const sqliteTarget = resolveSqliteTargetFromSessionStorePath(storePath, { agentId });
  if (sqliteTarget.path && !fs.existsSync(sqliteTarget.path)) {
    return {
      preservedRunning: 0,
      pruned: 0,
      nextSweepAtMs: null,
    };
  }
  return await withSessionRegistryEntriesInWorker(
    { agentId, storePath },
    async (entries, assertReaderCurrent) => {
      const assertCurrent = () => {
        params.assertCurrent?.();
        assertReaderCurrent();
      };
      assertCurrent();
      const store = Object.fromEntries(entries.map(({ sessionKey, entry }) => [sessionKey, entry]));
      const removals: SessionEntryLifecycleRemoval[] = [];
      const planned = pruneSessionRegistryStore({
        retentionMs: params.retentionMs,
        removals: params.apply ? removals : undefined,
        runningCronJobIds: params.runningCronJobIds,
        storePath,
        store,
      });
      if (removals.length > 0) {
        const mutation = await applySessionEntryLifecycleMutation({
          agentId,
          storePath,
          removals,
          skipMaintenance: true,
          commitGuard: assertCurrent,
        });
        assertCurrent();
        return {
          preservedRunning: planned.preservedRunning,
          pruned: mutation.removedEntries,
          nextSweepAtMs:
            mutation.removedEntries === planned.pruned
              ? planned.nextSweepAtMs
              : Date.now() + 60_000,
        };
      }
      return planned;
    },
  );
}
