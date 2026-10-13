import { performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { tryResolveCronJobEffectiveAgentId } from "../agent-id.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { resolveCronListSnapshotRevision } from "../list-snapshot-revision.js";
import { readCronScratchSnapshot } from "../scratch-read.js";
import { writeCronJobScratch } from "../scratch-store.js";
import { getCronJobsStoreRevision, noteCronJobsStoreCommit } from "../store.js";
import { CronJobsStoreChangedError } from "../store/save-error.js";
import type { CronJob } from "../types.js";
import {
  findJobOrThrow,
  isJobEnabled,
  nextWakeAtMs,
  resolveJobLastRunStatus,
} from "./jobs-scheduling.js";
import { sortCronJobs } from "./list-page-sort.js";
import type { CronListPageOptions, CronListPageResult } from "./list-page-types.js";
import { locked } from "./locked.js";
import { normalizeOptionalAgentId } from "./normalize.js";
import { ensureLoadedForRead, resolveCurrentDefaultAgentId } from "./ops-shared.js";
import type { CronServiceState } from "./state.js";
import { captureCronJobMutationSource, ensureLoaded } from "./store.js";

/** Called under the read lock, after loading passive or newly committed state. */
async function readSnapshot(
  state: CronServiceState,
): Promise<NonNullable<CronServiceState["readSnapshot"]>> {
  await ensureLoadedForRead(state);
  const storeRevision = getCronJobsStoreRevision(state.deps.storePath);
  const source = state.store?.jobs;
  const cached = state.schedulerStarted ? state.readSnapshot : undefined;
  if (cached?.storeRevision === storeRevision && cached.source === source) {
    return cached;
  }
  const sqlitePath = resolveOpenClawStateSqlitePath();
  return (state.readSnapshot = {
    storeRevision,
    source,
    readJobs: new WeakMap<CronJob, CronJob>(),
    status: Object.freeze({
      enabled: state.deps.cronEnabled,
      triggersEnabled: state.deps.cronConfig?.triggers?.enabled !== false,
      storePath: sqlitePath,
      storage: "sqlite" as const,
      sqlitePath,
      jobs: state.store?.jobs.length ?? 0,
      nextWakeAtMs: state.deps.cronEnabled ? (nextWakeAtMs(state) ?? null) : null,
    }),
  });
}

/** Returns the current scheduler generation's immutable aggregate status. */
export async function status(state: CronServiceState) {
  return await locked(state, async () => (await readSnapshot(state)).status, { readOnly: true });
}

/** Lists cron jobs sorted by next run time, excluding disabled jobs unless requested. */
export async function list(state: CronServiceState, opts?: { includeDisabled?: boolean }) {
  return await locked(
    state,
    async () => {
      await ensureLoadedForRead(state);
      const includeDisabled = opts?.includeDisabled === true;
      const jobs = (state.store?.jobs ?? []).filter((j) => includeDisabled || isJobEnabled(j));
      return sortCronJobs(jobs, "nextRunAtMs", "asc");
    },
    { readOnly: true },
  );
}

/** Reads one cron job by id without advancing due schedules. */
export async function readJob(state: CronServiceState, id: string) {
  return await locked(
    state,
    async () => {
      await ensureLoadedForRead(state);
      return state.store?.jobs.find((job) => job.id === id);
    },
    { readOnly: true },
  );
}

/** Reads one job's private scratch state after proving the job exists in this store. */
export async function readScratch(
  state: CronServiceState,
  id: string,
  options?: { assertCurrent?: () => void; signal?: AbortSignal },
) {
  const source = captureCronJobMutationSource(state);
  const callerCurrent = options?.assertCurrent;
  const signal = options?.signal;
  const assertCurrent = () => {
    source.assertCurrent();
    signal?.throwIfAborted();
    callerCurrent?.();
    source.assertCurrent();
  };
  return await locked(state, async () => {
    assertCurrent();
    await ensureLoaded(state);
    assertCurrent();
    const job = findJobOrThrow(state, id);
    const revision = resolveCronJobConfigRevision(job);
    const snapshot = await readCronScratchSnapshot(
      state.deps.storePath,
      { kind: "job", jobId: id, createdAtMsFallback: job.createdAtMs },
      {},
      { context: source.context, assertCurrent, signal },
    );
    assertCurrent();
    if (!snapshot || snapshot.configRevision !== revision) {
      // A foreign owner change cannot lend private content to the earlier authorized job.
      noteCronJobsStoreCommit(source.storeKey);
      throw new CronJobsStoreChangedError(source.storeKey);
    }
    return snapshot.state;
  });
}

/** Writes or clears one job's private scratch under the cron mutation lock. */
export async function writeScratch(
  state: CronServiceState,
  id: string,
  params: {
    content: string | null;
    expectedRevision?: number;
    sourceSha256?: string;
    commitGuard?: () => void;
  },
) {
  const source = captureCronJobMutationSource(state);
  return await locked(state, async () => {
    source.assertCurrent();
    await ensureLoaded(state);
    source.assertCurrent();
    const job = findJobOrThrow(state, id);
    const expectedRevision = resolveCronJobConfigRevision(job);
    return await writeCronJobScratch(
      {
        storePath: state.deps.storePath,
        jobId: id,
        content: params.content,
        expectedRevision: params.expectedRevision,
        sourceSha256: params.sourceSha256,
        nowMs: state.deps.nowMs(),
      },
      {
        context: source.context,
        createdAtMsFallback: job.createdAtMs,
        assertCurrent() {
          source.assertCurrent();
          params.commitGuard?.();
          source.assertCurrent();
        },
        expectedConfigRevision: expectedRevision,
      },
    ).catch((error: unknown) => {
      if (error instanceof Error && error.name === "CronJobsStoreChangedError") {
        noteCronJobsStoreCommit(source.storeKey);
        throw new CronJobsStoreChangedError(source.storeKey);
      }
      throw error;
    });
  });
}

const SLOW_LIST_PAGE_MS = 1_000;

/** Lists a filtered, sorted, bounded page of cron jobs for CLI/RPC callers. */
export async function listPage(
  state: CronServiceState,
  opts?: CronListPageOptions,
  matchesJob?: (job: CronJob) => boolean,
) {
  const startedAt = performance.now();
  let enteredAt: number | undefined;
  let finishedAt: number | undefined;
  let sourceCount: number | undefined;
  let result: CronListPageResult | undefined;
  try {
    return await locked(
      state,
      async () => {
        enteredAt = performance.now();
        try {
          const read = await readSnapshot(state);
          const query = normalizeLowercaseStringOrEmpty(opts?.query);
          const enabledFilter = opts?.enabled ?? (opts?.includeDisabled ? "all" : "enabled");
          const scheduleKindFilter = opts?.scheduleKind ?? "all";
          const lastRunStatusFilter = opts?.lastRunStatus ?? "all";
          const triggerFilter = opts?.trigger ?? "all";
          const sortBy = opts?.sortBy ?? "nextRunAtMs";
          const sortDir = opts?.sortDir ?? "asc";
          const requestedAgentId = normalizeOptionalAgentId(opts?.agentId);
          const source = state.store?.jobs ?? [];
          sourceCount = source.length;
          const filtered = source.filter((job) => {
            if (enabledFilter === "enabled" && !isJobEnabled(job)) {
              return false;
            }
            if (enabledFilter === "disabled" && isJobEnabled(job)) {
              return false;
            }
            if (
              requestedAgentId &&
              tryResolveCronJobEffectiveAgentId(job, resolveCurrentDefaultAgentId(state)) !==
                requestedAgentId
            ) {
              return false;
            }
            if (scheduleKindFilter !== "all" && job.schedule.kind !== scheduleKindFilter) {
              return false;
            }
            if (
              lastRunStatusFilter !== "all" &&
              (resolveJobLastRunStatus(job) ?? "unknown") !== lastRunStatusFilter
            ) {
              return false;
            }
            if (triggerFilter === "conditional" && !job.trigger) {
              return false;
            }
            if (triggerFilter === "unconditional" && job.trigger) {
              return false;
            }
            if (query) {
              const haystack = normalizeLowercaseStringOrEmpty(
                [
                  job.id,
                  job.name,
                  job.description ?? "",
                  job.agentId ?? "",
                  ...(job.displayName ? [job.displayName] : []),
                ].join(" "),
              );
              if (!haystack.includes(query)) {
                return false;
              }
            }
            // In-process visibility must share the sorted snapshot and its revision.
            return !matchesJob || matchesJob(job);
          });
          // Recheck visibility per request; passive readers still reload and repair.
          // Empty visibility prepasses must not evict the prepared nonempty list.
          let snapshot = read.list;
          if (
            !snapshot ||
            snapshot.sortBy !== sortBy ||
            snapshot.sortDir !== sortDir ||
            snapshot.filteredJobs.length !== filtered.length ||
            !snapshot.filteredJobs.every((job, index) => job === filtered[index])
          ) {
            const jobs = sortCronJobs([...filtered], sortBy, sortDir);
            snapshot = {
              filteredJobs: filtered,
              sortBy,
              sortDir,
              jobs,
              snapshotRevision: resolveCronListSnapshotRevision(jobs),
            };
            if (jobs.length > 0 || !read.list) {
              read.list = snapshot;
            }
          }
          const { jobs: sortedJobs, snapshotRevision } = snapshot;
          const total = sortedJobs.length;
          const offset = Math.max(0, Math.min(total, Math.floor(opts?.offset ?? 0)));
          const defaultLimit = total === 0 ? 50 : total;
          const limit = Math.max(1, Math.min(200, Math.floor(opts?.limit ?? defaultLimit)));
          const jobs = sortedJobs.slice(offset, offset + limit).map((job) => {
            let frozenJob = read.readJobs.get(job);
            if (!frozenJob) {
              frozenJob = freezeJsonSnapshot(structuredClone(job));
              read.readJobs.set(job, frozenJob);
            }
            return frozenJob;
          });
          const nextOffset = offset + jobs.length;
          return (result = {
            jobs,
            snapshotRevision,
            total,
            offset,
            limit,
            hasMore: nextOffset < total,
            nextOffset: nextOffset < total ? nextOffset : null,
          } satisfies CronListPageResult);
        } finally {
          finishedAt = performance.now();
        }
      },
      { readOnly: true },
    );
  } finally {
    const completedAt = performance.now();
    const elapsedMs = completedAt - startedAt;
    if (elapsedMs >= SLOW_LIST_PAGE_MS) {
      // These are wall times: waiting includes scheduling, and callback awaits
      // include unrelated work. Keep queue completion delay separate from both.
      try {
        state.deps.log.warn(
          {
            operation: "cron.listPage",
            pid: process.pid,
            threadId,
            isMainThread,
            elapsedMs: Math.round(elapsedMs),
            waitToCallbackMs:
              enteredAt === undefined ? undefined : Math.round(enteredAt - startedAt),
            callbackMs:
              enteredAt === undefined || finishedAt === undefined
                ? undefined
                : Math.round(finishedAt - enteredAt),
            completionDelayMs:
              finishedAt === undefined ? undefined : Math.round(completedAt - finishedAt),
            sourceCount,
            matchedCount: result?.total,
            returnedCount: result?.jobs.length,
            outcome: result ? "ok" : "error",
            thresholdMs: SLOW_LIST_PAGE_MS,
          },
          "cron: slow list page",
        );
      } catch {
        // Diagnostics must not replace the operation result or original error.
      }
    }
  }
}
