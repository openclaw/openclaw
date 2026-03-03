import { applyJobPatch, computeJobNextRunAtMs, createJob, findJobOrThrow, isJobDue, nextWakeAtMs, recomputeNextRuns, recomputeNextRunsForMaintenance, } from "./jobs.js";
import { locked } from "./locked.js";
import { ensureLoaded, persist, warnIfDisabled } from "./store.js";
import { applyJobResult, armTimer, emit, executeJobCoreWithTimeout, runMissedJobs, stopTimer, wake, } from "./timer.js";
function mergeManualRunSnapshotAfterReload(params) {
    if (!params.state.store) {
        return;
    }
    if (params.removed) {
        params.state.store.jobs = params.state.store.jobs.filter((job) => job.id !== params.jobId);
        return;
    }
    if (!params.snapshot) {
        return;
    }
    const reloaded = params.state.store.jobs.find((job) => job.id === params.jobId);
    if (!reloaded) {
        return;
    }
    reloaded.enabled = params.snapshot.enabled;
    reloaded.updatedAtMs = params.snapshot.updatedAtMs;
    reloaded.state = params.snapshot.state;
}
async function ensureLoadedForRead(state) {
    await ensureLoaded(state, { skipRecompute: true });
    if (!state.store) {
        return;
    }
    // Use the maintenance-only version so that read-only operations never
    // advance a past-due nextRunAtMs without executing the job (#16156).
    const changed = recomputeNextRunsForMaintenance(state);
    if (changed) {
        await persist(state);
    }
}
export async function start(state) {
    if (!state.deps.cronEnabled) {
        state.deps.log.info({ enabled: false }, "cron: disabled");
        return;
    }
    const startupInterruptedJobIds = new Set();
    await locked(state, async () => {
        await ensureLoaded(state, { skipRecompute: true });
        const jobs = state.store?.jobs ?? [];
        for (const job of jobs) {
            if (typeof job.state.runningAtMs === "number") {
                state.deps.log.warn({ jobId: job.id, runningAtMs: job.state.runningAtMs }, "cron: clearing stale running marker on startup");
                job.state.runningAtMs = undefined;
                startupInterruptedJobIds.add(job.id);
            }
        }
        await persist(state);
    });
    await runMissedJobs(state, { skipJobIds: startupInterruptedJobIds });
    await locked(state, async () => {
        await ensureLoaded(state, { forceReload: true, skipRecompute: true });
        recomputeNextRuns(state);
        await persist(state);
        armTimer(state);
        state.deps.log.info({
            enabled: true,
            jobs: state.store?.jobs.length ?? 0,
            nextWakeAtMs: nextWakeAtMs(state) ?? null,
        }, "cron: started");
    });
}
export function stop(state) {
    stopTimer(state);
}
export async function status(state) {
    return await locked(state, async () => {
        await ensureLoadedForRead(state);
        return {
            enabled: state.deps.cronEnabled,
            storePath: state.deps.storePath,
            jobs: state.store?.jobs.length ?? 0,
            nextWakeAtMs: state.deps.cronEnabled ? (nextWakeAtMs(state) ?? null) : null,
        };
    });
}
export async function list(state, opts) {
    return await locked(state, async () => {
        await ensureLoadedForRead(state);
        const includeDisabled = opts?.includeDisabled === true;
        const jobs = (state.store?.jobs ?? []).filter((j) => includeDisabled || j.enabled);
        return jobs.toSorted((a, b) => (a.state.nextRunAtMs ?? 0) - (b.state.nextRunAtMs ?? 0));
    });
}
function resolveEnabledFilter(opts) {
    if (opts?.enabled === "all" || opts?.enabled === "enabled" || opts?.enabled === "disabled") {
        return opts.enabled;
    }
    return opts?.includeDisabled ? "all" : "enabled";
}
function sortJobs(jobs, sortBy, sortDir) {
    const dir = sortDir === "desc" ? -1 : 1;
    return jobs.toSorted((a, b) => {
        let cmp = 0;
        if (sortBy === "name") {
            const aName = typeof a.name === "string" ? a.name : "";
            const bName = typeof b.name === "string" ? b.name : "";
            cmp = aName.localeCompare(bName, undefined, { sensitivity: "base" });
        }
        else if (sortBy === "updatedAtMs") {
            cmp = a.updatedAtMs - b.updatedAtMs;
        }
        else {
            const aNext = a.state.nextRunAtMs;
            const bNext = b.state.nextRunAtMs;
            if (typeof aNext === "number" && typeof bNext === "number") {
                cmp = aNext - bNext;
            }
            else if (typeof aNext === "number") {
                cmp = -1;
            }
            else if (typeof bNext === "number") {
                cmp = 1;
            }
            else {
                cmp = 0;
            }
        }
        if (cmp !== 0) {
            return cmp * dir;
        }
        const aId = typeof a.id === "string" ? a.id : "";
        const bId = typeof b.id === "string" ? b.id : "";
        return aId.localeCompare(bId);
    });
}
export async function listPage(state, opts) {
    return await locked(state, async () => {
        await ensureLoadedForRead(state);
        const query = opts?.query?.trim().toLowerCase() ?? "";
        const enabledFilter = resolveEnabledFilter(opts);
        const sortBy = opts?.sortBy ?? "nextRunAtMs";
        const sortDir = opts?.sortDir ?? "asc";
        const source = state.store?.jobs ?? [];
        const filtered = source.filter((job) => {
            if (enabledFilter === "enabled" && !job.enabled) {
                return false;
            }
            if (enabledFilter === "disabled" && job.enabled) {
                return false;
            }
            if (!query) {
                return true;
            }
            const haystack = [job.name, job.description ?? "", job.agentId ?? ""].join(" ").toLowerCase();
            return haystack.includes(query);
        });
        const sorted = sortJobs(filtered, sortBy, sortDir);
        const total = sorted.length;
        const offset = Math.max(0, Math.min(total, Math.floor(opts?.offset ?? 0)));
        const defaultLimit = total === 0 ? 50 : total;
        const limit = Math.max(1, Math.min(200, Math.floor(opts?.limit ?? defaultLimit)));
        const jobs = sorted.slice(offset, offset + limit);
        const nextOffset = offset + jobs.length;
        return {
            jobs,
            total,
            offset,
            limit,
            hasMore: nextOffset < total,
            nextOffset: nextOffset < total ? nextOffset : null,
        };
    });
}
export async function add(state, input) {
    return await locked(state, async () => {
        warnIfDisabled(state, "add");
        await ensureLoaded(state);
        const job = createJob(state, input);
        state.store?.jobs.push(job);
        // Defensive: recompute all next-run times to ensure consistency
        recomputeNextRuns(state);
        await persist(state);
        armTimer(state);
        state.deps.log.info({
            jobId: job.id,
            jobName: job.name,
            nextRunAtMs: job.state.nextRunAtMs,
            schedulerNextWakeAtMs: nextWakeAtMs(state) ?? null,
            timerArmed: state.timer !== null,
            cronEnabled: state.deps.cronEnabled,
        }, "cron: job added");
        emit(state, {
            jobId: job.id,
            action: "added",
            nextRunAtMs: job.state.nextRunAtMs,
        });
        return job;
    });
}
export async function update(state, id, patch) {
    return await locked(state, async () => {
        warnIfDisabled(state, "update");
        await ensureLoaded(state, { skipRecompute: true });
        const job = findJobOrThrow(state, id);
        const now = state.deps.nowMs();
        applyJobPatch(job, patch, { defaultAgentId: state.deps.defaultAgentId });
        if (job.schedule.kind === "every") {
            const anchor = job.schedule.anchorMs;
            if (typeof anchor !== "number" || !Number.isFinite(anchor)) {
                const patchSchedule = patch.schedule;
                const fallbackAnchorMs = patchSchedule?.kind === "every"
                    ? now
                    : typeof job.createdAtMs === "number" && Number.isFinite(job.createdAtMs)
                        ? job.createdAtMs
                        : now;
                job.schedule = {
                    ...job.schedule,
                    anchorMs: Math.max(0, Math.floor(fallbackAnchorMs)),
                };
            }
        }
        const scheduleChanged = patch.schedule !== undefined;
        const enabledChanged = patch.enabled !== undefined;
        job.updatedAtMs = now;
        if (scheduleChanged || enabledChanged) {
            if (job.enabled) {
                job.state.nextRunAtMs = computeJobNextRunAtMs(job, now);
            }
            else {
                job.state.nextRunAtMs = undefined;
                job.state.runningAtMs = undefined;
            }
        }
        else if (job.enabled) {
            // Non-schedule edits should not mutate other jobs, but still repair a
            // missing/corrupt nextRunAtMs for the updated job.
            const nextRun = job.state.nextRunAtMs;
            if (typeof nextRun !== "number" || !Number.isFinite(nextRun)) {
                job.state.nextRunAtMs = computeJobNextRunAtMs(job, now);
            }
        }
        await persist(state);
        armTimer(state);
        emit(state, {
            jobId: id,
            action: "updated",
            nextRunAtMs: job.state.nextRunAtMs,
        });
        return job;
    });
}
export async function remove(state, id) {
    return await locked(state, async () => {
        warnIfDisabled(state, "remove");
        await ensureLoaded(state);
        const before = state.store?.jobs.length ?? 0;
        if (!state.store) {
            return { ok: false, removed: false };
        }
        state.store.jobs = state.store.jobs.filter((j) => j.id !== id);
        const removed = (state.store.jobs.length ?? 0) !== before;
        await persist(state);
        armTimer(state);
        if (removed) {
            emit(state, { jobId: id, action: "removed" });
        }
        return { ok: true, removed };
    });
}
export async function run(state, id, mode) {
    const prepared = await locked(state, async () => {
        warnIfDisabled(state, "run");
        await ensureLoaded(state, { skipRecompute: true });
        // Normalize job tick state (clears stale runningAtMs markers) before
        // checking if already running, so a stale marker from a crashed Phase-1
        // persist does not block manual triggers for up to STUCK_RUN_MS (#17554).
        recomputeNextRunsForMaintenance(state);
        const job = findJobOrThrow(state, id);
        if (typeof job.state.runningAtMs === "number") {
            return { ok: true, ran: false, reason: "already-running" };
        }
        const now = state.deps.nowMs();
        const due = isJobDue(job, now, { forced: mode === "force" });
        if (!due) {
            return { ok: true, ran: false, reason: "not-due" };
        }
        // Reserve this run under lock, then execute outside lock so read ops
        // (`list`, `status`) stay responsive while the run is in progress.
        job.state.runningAtMs = now;
        job.state.lastError = undefined;
        // Persist the running marker before releasing lock so timer ticks that
        // force-reload from disk cannot start the same job concurrently.
        await persist(state);
        emit(state, { jobId: job.id, action: "started", runAtMs: now });
        const executionJob = JSON.parse(JSON.stringify(job));
        return {
            ok: true,
            ran: true,
            jobId: job.id,
            startedAt: now,
            executionJob,
        };
    });
    if (!prepared.ran) {
        return prepared;
    }
    if (!prepared.executionJob || typeof prepared.startedAt !== "number") {
        return { ok: false };
    }
    const executionJob = prepared.executionJob;
    const startedAt = prepared.startedAt;
    const jobId = prepared.jobId;
    let coreResult;
    try {
        coreResult = await executeJobCoreWithTimeout(state, executionJob);
    }
    catch (err) {
        coreResult = { status: "error", error: String(err) };
    }
    const endedAt = state.deps.nowMs();
    await locked(state, async () => {
        await ensureLoaded(state, { skipRecompute: true });
        const job = state.store?.jobs.find((entry) => entry.id === jobId);
        if (!job) {
            return;
        }
        const shouldDelete = applyJobResult(state, job, {
            status: coreResult.status,
            error: coreResult.error,
            delivered: coreResult.delivered,
            startedAt,
            endedAt,
        });
        emit(state, {
            jobId: job.id,
            action: "finished",
            status: coreResult.status,
            error: coreResult.error,
            summary: coreResult.summary,
            delivered: coreResult.delivered,
            deliveryStatus: job.state.lastDeliveryStatus,
            deliveryError: job.state.lastDeliveryError,
            sessionId: coreResult.sessionId,
            sessionKey: coreResult.sessionKey,
            runAtMs: startedAt,
            durationMs: job.state.lastDurationMs,
            nextRunAtMs: job.state.nextRunAtMs,
            model: coreResult.model,
            provider: coreResult.provider,
            usage: coreResult.usage,
        });
        if (shouldDelete && state.store) {
            state.store.jobs = state.store.jobs.filter((entry) => entry.id !== job.id);
            emit(state, { jobId: job.id, action: "removed" });
        }
        // Manual runs should not advance other due jobs without executing them.
        // Use maintenance-only recompute to repair missing values while
        // preserving existing past-due nextRunAtMs entries for future timer ticks.
        const postRunSnapshot = shouldDelete
            ? null
            : {
                enabled: job.enabled,
                updatedAtMs: job.updatedAtMs,
                state: structuredClone(job.state),
            };
        const postRunRemoved = shouldDelete;
        // Isolated Telegram send can persist target writeback directly to disk.
        // Reload before final persist so manual `cron run` keeps those changes.
        await ensureLoaded(state, { forceReload: true, skipRecompute: true });
        mergeManualRunSnapshotAfterReload({
            state,
            jobId,
            snapshot: postRunSnapshot,
            removed: postRunRemoved,
        });
        recomputeNextRunsForMaintenance(state);
        await persist(state);
        armTimer(state);
    });
    return { ok: true, ran: true };
}
export function wakeNow(state, opts) {
    return wake(state, opts);
}
