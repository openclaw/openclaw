import { performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  heartbeatScratchNotesView,
  replaceHeartbeatScratchNotes,
} from "../../infra/heartbeat-questions.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { tryResolveCronJobEffectiveAgentId } from "../agent-id.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { resolveCronListSnapshotRevision } from "../list-snapshot-revision.js";
import type { CronJobScratchState } from "../scratch-contract.js";
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
import type {
  CronJobsEnabledFilter,
  CronJobsLastRunStatusFilter,
  CronJobsScheduleKindFilter,
  CronJobsTriggerFilter,
  CronListPageOptions,
  CronListPageResult,
} from "./list-page-types.js";
import { locked } from "./locked.js";
import { normalizeOptionalAgentId } from "./normalize.js";
import { ensureLoadedForRead, resolveCurrentDefaultAgentId } from "./ops-shared.js";
import type { CronServiceState } from "./state.js";
import { captureCronJobMutationSource, ensureLoaded } from "./store.js";

/** Returns cron service status after a read-only maintenance pass. */
export async function status(state: CronServiceState) {
  return await locked(
    state,
    async () => {
      await ensureLoadedForRead(state);
      const sqlitePath = resolveOpenClawStateSqlitePath();
      return {
        enabled: state.deps.cronEnabled,
        triggersEnabled: state.deps.cronConfig?.triggers?.enabled !== false,
        storePath: sqlitePath,
        storage: "sqlite" as const,
        sqlitePath,
        jobs: state.store?.jobs.length ?? 0,
        nextWakeAtMs: state.deps.cronEnabled ? (nextWakeAtMs(state) ?? null) : null,
      };
    },
    { readOnly: true },
  );
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

/** Heartbeat monitors expose only their notes; question groups are managed by their tool. */
function heartbeatNotesView<T extends Pick<CronJobScratchState, "scratch">>(scratchState: T): T {
  return scratchState.scratch
    ? {
        ...scratchState,
        scratch: {
          ...scratchState.scratch,
          content: heartbeatScratchNotesView(scratchState.scratch.content),
        },
      }
    : scratchState;
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
    return job.payload.kind === "heartbeat" ? heartbeatNotesView(snapshot.state) : snapshot.state;
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
    let content = params.content;
    let scratchRevision = params.expectedRevision;
    if (job.payload.kind === "heartbeat") {
      const snapshot = await readCronScratchSnapshot(
        state.deps.storePath,
        { kind: "job", jobId: id, createdAtMsFallback: job.createdAtMs },
        {},
        { context: source.context, assertCurrent: source.assertCurrent },
      );
      if (!snapshot || snapshot.configRevision !== expectedRevision) {
        noteCronJobsStoreCommit(source.storeKey);
        throw new CronJobsStoreChangedError(source.storeKey);
      }
      content = replaceHeartbeatScratchNotes(snapshot.state.scratch?.content, params.content);
      // Tool edits do not take this lock; the worker CAS preserves their groups.
      scratchRevision ??= snapshot.state.currentRevision;
    }
    const result = await writeCronJobScratch(
      {
        storePath: state.deps.storePath,
        jobId: id,
        content,
        expectedRevision: scratchRevision,
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
        assertJobCurrent(configRevision) {
          if (configRevision !== expectedRevision) {
            // The foreign commit invalidates the resident definition used by the caller guard.
            noteCronJobsStoreCommit(source.storeKey);
            throw new CronJobsStoreChangedError(source.storeKey);
          }
        },
      },
    );
    return result.ok && job.payload.kind === "heartbeat" ? heartbeatNotesView(result) : result;
  });
}

function resolveEnabledFilter(opts?: CronListPageOptions): CronJobsEnabledFilter {
  if (opts?.enabled === "all" || opts?.enabled === "enabled" || opts?.enabled === "disabled") {
    return opts.enabled;
  }
  return opts?.includeDisabled ? "all" : "enabled";
}

function resolveScheduleKindFilter(opts?: CronListPageOptions): CronJobsScheduleKindFilter {
  const kind = opts?.scheduleKind;
  return kind && ["all", "at", "every", "cron", "on-exit", "stream"].includes(kind) ? kind : "all";
}

function resolveLastRunStatusFilter(opts?: CronListPageOptions): CronJobsLastRunStatusFilter {
  const lastRunStatus = opts?.lastRunStatus;
  return lastRunStatus && ["all", "ok", "error", "skipped", "unknown"].includes(lastRunStatus)
    ? lastRunStatus
    : "all";
}

function resolveTriggerFilter(opts?: CronListPageOptions): CronJobsTriggerFilter {
  const trigger = opts?.trigger;
  return trigger && ["all", "conditional", "unconditional"].includes(trigger) ? trigger : "all";
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
          await ensureLoadedForRead(state);
          const query = normalizeLowercaseStringOrEmpty(opts?.query);
          const enabledFilter = resolveEnabledFilter(opts);
          const scheduleKindFilter = resolveScheduleKindFilter(opts);
          const lastRunStatusFilter = resolveLastRunStatusFilter(opts);
          const triggerFilter = resolveTriggerFilter(opts);
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
          // Recheck visibility on every request; only sorting and full-result hashing
          // share the owner's prepared snapshot. Passive readers still reload/repair.
          const storeRevision = getCronJobsStoreRevision(state.deps.storePath);
          let snapshot = state.schedulerStarted ? state.listPageSnapshot : undefined;
          if (
            !snapshot ||
            snapshot.storeRevision !== storeRevision ||
            snapshot.sortBy !== sortBy ||
            snapshot.sortDir !== sortDir ||
            snapshot.filteredJobs.length !== filtered.length ||
            !snapshot.filteredJobs.every((job, index) => job === filtered[index])
          ) {
            const jobs = sortCronJobs([...filtered], sortBy, sortDir);
            snapshot = {
              storeRevision,
              filteredJobs: filtered,
              sortBy,
              sortDir,
              jobs,
              snapshotRevision: resolveCronListSnapshotRevision(jobs),
            };
            if (state.schedulerStarted) {
              state.listPageSnapshot = snapshot;
            }
          }
          const { jobs: sortedJobs, snapshotRevision } = snapshot;
          const total = sortedJobs.length;
          const offset = Math.max(0, Math.min(total, Math.floor(opts?.offset ?? 0)));
          const defaultLimit = total === 0 ? 50 : total;
          const limit = Math.max(1, Math.min(200, Math.floor(opts?.limit ?? defaultLimit)));
          const jobs = structuredClone(sortedJobs.slice(offset, offset + limit));
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
