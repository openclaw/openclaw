import { performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { tryResolveCronJobEffectiveAgentId } from "../agent-id.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import {
  resolveCronListSnapshotRevision,
  resolveCronListSnapshotRows,
} from "../list-snapshot-revision.js";
import { readCronScratchSnapshotByKey } from "../scratch-read.js";
import { writeCronJobScratchByKey } from "../scratch-store.js";
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
import { reloadProvisionedCronJobs } from "./ops-lifecycle.js";
import { ensureLoadedForRead, resolveCurrentDefaultAgentId } from "./ops-shared.js";
import { prepareCronServiceStore, type CronServiceState } from "./state.js";
import { captureCronJobMutationSource, ensureLoaded } from "./store.js";

/** Called under the read lock, after loading passive or newly committed state. */
async function readSnapshot(
  state: CronServiceState,
): Promise<NonNullable<CronServiceState["readSnapshot"]>> {
  await ensureLoadedForRead(state);
  const storeRevision = getCronJobsStoreRevision(state.deps.storeKey);
  const source = state.store?.jobs;
  const cached = state.schedulerStarted ? state.readSnapshot : undefined;
  if (cached?.storeRevision === storeRevision && cached.source === source) {
    return cached;
  }
  const sqlitePath = resolveOpenClawStateSqlitePath();
  return (state.readSnapshot = {
    storeRevision,
    source,
    lists: [],
    searchText: new WeakMap<CronJob, string>(),
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
  return await locked(state, async () => (await readSnapshot(state)).status);
}

/** Lists cron jobs sorted by next run time, excluding disabled jobs unless requested. */
export async function list(state: CronServiceState, opts?: { includeDisabled?: boolean }) {
  return await locked(state, async () => {
    await ensureLoadedForRead(state);
    const includeDisabled = opts?.includeDisabled === true;
    const jobs = (state.store?.jobs ?? []).filter((j) => includeDisabled || isJobEnabled(j));
    return sortCronJobs(jobs, "nextRunAtMs", "asc");
  });
}

/** Reads one cron job by id without advancing due schedules. */
export async function readJob(state: CronServiceState, id: string) {
  return await locked(state, async () => {
    if (
      state.deps.cronEnabled &&
      state.schedulerStarted &&
      !state.stopped &&
      !state.store?.jobs.some((job) => job.id === id)
    ) {
      // Setup acknowledges its newly committed ID through cron.get; no tick exists in an empty scheduler.
      const generation = state.lifecycleGeneration;
      const previousIds = new Set(state.store?.jobs.map((job) => job.id));
      await ensureLoaded(state, { forceReload: true });
      await reloadProvisionedCronJobs(state, generation, previousIds);
    } else {
      await ensureLoadedForRead(state);
    }
    return state.store?.jobs.find((job) => job.id === id);
  });
}

/** Reads one job's private scratch state after proving the job exists in this store. */
export async function readScratch(
  state: CronServiceState,
  id: string,
  options?: { assertCurrent?: () => void; signal?: AbortSignal },
) {
  const preparation = prepareCronServiceStore(state);
  if (preparation) {
    await preparation;
  }
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
    const snapshot = await readCronScratchSnapshotByKey(
      state.deps.storeKey,
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
  const preparation = prepareCronServiceStore(state);
  if (preparation) {
    await preparation;
  }
  const source = captureCronJobMutationSource(state);
  return await locked(state, async () => {
    source.assertCurrent();
    await ensureLoaded(state);
    source.assertCurrent();
    const job = findJobOrThrow(state, id);
    const expectedRevision = resolveCronJobConfigRevision(job);
    return await writeCronJobScratchByKey(
      {
        storeKey: state.deps.storeKey,
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
const MAX_LIST_SNAPSHOTS = 4;

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
    return await locked(state, async () => {
      enteredAt = performance.now();
      try {
        const read = await readSnapshot(state);
        // Normalize comparison text only; stored cron job fields stay original.
        const query = normalizeLowercaseStringOrEmpty(opts?.query).normalize("NFC");
        const enabledFilter = opts?.enabled ?? (opts?.includeDisabled ? "all" : "enabled");
        const scheduleKindFilter = opts?.scheduleKind ?? "all";
        const lastRunStatusFilter = opts?.lastRunStatus ?? "all";
        const triggerFilter = opts?.trigger ?? "all";
        const sortBy = opts?.sortBy ?? "nextRunAtMs";
        const sortDir = opts?.sortDir ?? "asc";
        const requestedAgentId = normalizeOptionalAgentId(opts?.agentId);
        const source = state.store?.jobs ?? [];
        sourceCount = source.length;
        const defaultAgentId = requestedAgentId ? resolveCurrentDefaultAgentId(state) : undefined;
        const filtered = source.filter((job) => {
          if (enabledFilter === "enabled" && !isJobEnabled(job)) {
            return false;
          }
          if (enabledFilter === "disabled" && isJobEnabled(job)) {
            return false;
          }
          if (
            requestedAgentId &&
            tryResolveCronJobEffectiveAgentId(job, defaultAgentId) !== requestedAgentId
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
            let haystack = read.searchText.get(job);
            if (haystack === undefined) {
              haystack = normalizeLowercaseStringOrEmpty(
                [
                  job.id,
                  job.name,
                  job.description ?? "",
                  job.agentId ?? "",
                  ...(job.displayName ? [job.displayName] : []),
                ].join(" "),
              ).normalize("NFC");
              read.searchText.set(job, haystack);
            }
            if (!haystack.includes(query)) {
              return false;
            }
          }
          // In-process visibility must share the sorted snapshot and its revision.
          return !matchesJob || matchesJob(job);
        });
        // Recheck visibility before sharing work across interleaved list variants.
        let snapshot = read.lists.find(
          (candidate) =>
            candidate.sortBy === sortBy &&
            candidate.sortDir === sortDir &&
            candidate.filteredJobs.length === filtered.length &&
            candidate.filteredJobs.every((job, index) => job === filtered[index]),
        );
        if (!snapshot) {
          // A list miss also covers row replacements inside the same source array.
          const readJobs = resolveCronListSnapshotRows(source, state.listSnapshotRows);
          state.listSnapshotRows = readJobs;
          const jobs = sortCronJobs(
            filtered.map((job) => readJobs.get(job.id)!.job),
            sortBy,
            sortDir,
          );
          snapshot = {
            filteredJobs: filtered,
            sortBy,
            sortDir,
            jobs,
            snapshotRevision: resolveCronListSnapshotRevision(jobs, readJobs),
          };
          // Empty visibility prepasses must not evict prepared nonempty lists.
          if (jobs.length > 0 || read.lists.length === 0) {
            read.lists.push(snapshot);
            if (read.lists.length > MAX_LIST_SNAPSHOTS) {
              read.lists.shift();
            }
          }
        }
        const { jobs: sortedJobs, snapshotRevision } = snapshot;
        const total = sortedJobs.length;
        const offset = Math.max(0, Math.min(total, Math.floor(opts?.offset ?? 0)));
        const defaultLimit = total === 0 ? 50 : total;
        const limit = Math.max(1, Math.min(200, Math.floor(opts?.limit ?? defaultLimit)));
        const jobs = sortedJobs.slice(offset, offset + limit);
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
    });
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
