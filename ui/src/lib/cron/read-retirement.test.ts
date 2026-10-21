// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createRequireRecord } from "../../../../test/helpers/record.js";
import type { CronJob, CronJobsListResult, CronRunsResult } from "../../api/types.ts";
import {
  createMethodRequest,
  createCronRunsResult,
  createCronJob,
  createStateWithRequest,
  cronJobsListResponse,
} from "./cron.test-support.ts";
import {
  addCronJob,
  cancelCronEdit,
  toggleCronJob,
  invalidateCronRefresh,
  loadCronJobsPage,
  runCronJob,
  startCronEdit,
  updateCronJobsFilter,
} from "./index.ts";
import { loadCronRuns, updateCronRunsFilter } from "./runs.ts";
import { loadCronStatus } from "./state.ts";
import type { CronState } from "./types.ts";

const requireRecord = createRequireRecord("record", "expected-label-record");

function runEntry(jobId: string, ts: number) {
  return { ts, jobId, action: "finished", status: "ok" } as const;
}

function createCronJobsReloadHarness(stateOverrides: Partial<CronState> = {}) {
  const first = createDeferred<CronJobsListResult>();
  const payloads: unknown[] = [];
  const request = vi.fn(async (method: string, payload?: unknown) => {
    if (method !== "cron.list") {
      return {};
    }
    payloads.push(payload);
    return payloads.length === 1 ? first.promise : cronJobsListResponse();
  });
  return {
    first,
    payloads,
    request,
    state: createStateWithRequest(request, stateOverrides),
  };
}

describe("cron controller", () => {
  it("appends jobs only from the accepted snapshot revision", async () => {
    const firstJob = createCronJob("job-1", "First");
    const secondJob = createCronJob("job-2", "Second");
    const request = vi.fn(async () =>
      cronJobsListResponse([secondJob], {
        snapshotRevision: "stable-revision",
        total: 2,
        offset: 1,
        limit: 1,
      }),
    );
    const state = createStateWithRequest(request, {
      cronJobs: [firstJob],
      cronJobsSnapshotRevision: "stable-revision",
      cronJobsTotal: 2,
      cronJobsHasMore: true,
      cronJobsNextOffset: 1,
      cronJobsLimit: 1,
    });

    await loadCronJobsPage(state, { append: true });

    expect(state.cronJobs.map((job) => job.id)).toEqual(["job-1", "job-2"]);
    expect(state.cronJobsSnapshotRevision).toBe("stable-revision");
    expect(state.cronJobsHasMore).toBe(false);
    expect(state.cronJobsNextOffset).toBeNull();
  });

  it("restarts at page zero instead of committing an append from a changed snapshot", async () => {
    const staleJob = createCronJob("stale-only", "Stale");
    const stableJob = createCronJob("stable", "Stable");
    const currentJob = createCronJob("current", "Current");
    const responses = [
      cronJobsListResponse([staleJob, stableJob], {
        snapshotRevision: "revision-a",
        total: 3,
        limit: 2,
        hasMore: true,
        nextOffset: 2,
      }),
      cronJobsListResponse([], {
        snapshotRevision: "revision-b",
        total: 2,
        offset: 2,
        limit: 2,
      }),
      cronJobsListResponse([stableJob, currentJob], {
        snapshotRevision: "revision-b",
        total: 2,
        limit: 2,
      }),
    ];
    const offsets: number[] = [];
    const request = vi.fn(async (_method: string, payload?: unknown) => {
      offsets.push(requireRecord(payload, "cron.list payload").offset as number);
      const response = responses.shift();
      if (!response) {
        throw new Error("unexpected cron.list call");
      }
      return response;
    });
    const state = createStateWithRequest(request, { cronJobsLimit: 2 });

    await loadCronJobsPage(state);
    await loadCronJobsPage(state, { append: true });

    expect(offsets).toEqual([0, 2, 0]);
    expect(state.cronJobs.map((job) => job.id)).toEqual(["stable", "current"]);
    expect(state.cronJobsSnapshotRevision).toBe("revision-b");
    expect(state.cronJobsTotal).toBe(2);
    expect(state.cronJobsHasMore).toBe(false);
    expect(state.cronJobsNextOffset).toBeNull();
  });

  it("retains the last coherent page when snapshot metadata is invalid", async () => {
    const job = createCronJob("existing", "Existing");
    const request = createMethodRequest({
      "cron.list": { ...cronJobsListResponse(), snapshotRevision: undefined },
    });
    const state = createStateWithRequest(request, {
      cronJobs: [job],
      cronJobsSnapshotRevision: "accepted",
      cronJobsTotal: 1,
    });
    await loadCronJobsPage(state);
    expect(state).toMatchObject({
      cronJobs: [job],
      cronJobsSnapshotRevision: "accepted",
      cronJobsTotal: 1,
      cronError: null,
    });
    expect(state.cronJobsError).toContain("cron.list returned an invalid inventory page");
  });

  it.each([true, false])("reloads with the latest table-filter mode %s", async (tableFilters) => {
    const { first, payloads, request, state } = createCronJobsReloadHarness(
      tableFilters
        ? {
            cronJobsSnapshotRevision: "revision-a",
            cronJobsTotal: 2,
            cronJobsHasMore: true,
            cronJobsNextOffset: 1,
          }
        : { cronJobsScheduleKindFilter: "cron", cronJobsLastStatusFilter: "unknown" },
    );
    const pending = loadCronJobsPage(state, { append: tableFilters, tableFilters });
    updateCronJobsFilter(state, {
      cronJobsScheduleKindFilter: "cron",
      cronJobsLastStatusFilter: "unknown",
    });
    await loadCronJobsPage(state, { tableFilters: true });
    if (!tableFilters) {
      await loadCronJobsPage(state);
    }
    first.resolve(
      cronJobsListResponse(
        [],
        tableFilters ? { snapshotRevision: "revision-b", total: 1, offset: 1 } : {},
      ),
    );
    await pending;
    expect(payloads[0]).toMatchObject({ offset: tableFilters ? 1 : 0 });
    expect(payloads[1]).toMatchObject({ offset: 0 });
    if (tableFilters) {
      expect(payloads[1]).toMatchObject({ scheduleKind: "cron", lastRunStatus: "unknown" });
    } else {
      for (const field of ["scheduleKind", "lastRunStatus", "trigger"]) {
        expect(payloads[1]).not.toHaveProperty(field);
      }
    }
    expect(request).toHaveBeenCalledTimes(2);
    expect(state).toMatchObject({
      cronJobsReloadPending: false,
      cronJobsReloadPendingTableFilters: false,
      cronJobsSnapshotRevision: "cron-jobs-fixture",
    });
  });

  it.each([
    { label: "filters", patch: { cronRunsStatuses: ["error"], cronRunsQuery: "filtered" } },
  ] satisfies Array<{ label: string; patch: Parameters<typeof updateCronRunsFilter>[1] }>)(
    "drops an older append after replacing history $label",
    async ({ patch }) => {
      const current = { ...runEntry("filtered", 3), status: "error" as const };
      const older = createDeferred<CronRunsResult>();
      const request = vi
        .fn()
        .mockResolvedValueOnce(
          createCronRunsResult([runEntry("previous", 2)], {
            total: 2,
            hasMore: true,
            nextOffset: 1,
          }),
        )
        .mockReturnValueOnce(older.promise)
        .mockResolvedValueOnce(createCronRunsResult([current]));
      const state = createStateWithRequest(request);
      await loadCronRuns(state);
      const pending = loadCronRuns(state, { append: true });
      expect(state.cronRunsLoadingMore).toBe(true);
      updateCronRunsFilter(state, patch);
      await expect(loadCronRuns(state)).resolves.toBe("ok");
      expect(state.cronRunsLoadingMore).toBe(false);
      older.resolve(
        createCronRunsResult([runEntry("stale", 1)], { total: 9, hasMore: true, nextOffset: 2 }),
      );
      await expect(pending).resolves.toBe("skipped");
      expect(state).toMatchObject({
        cronRuns: [current],
        cronRunsHasMore: false,
        cronRunsLoadingMore: false,
      });
    },
  );
});

describe("selected automation runtime refresh", () => {
  it.each(["close and reopen", "agent", "connection", "invalidate"] as const)(
    "rejects a retained read after %s changes its owner",
    async (change) => {
      const job = createCronJob("selected", "Saved", { state: { triggerEvalCount: 1 } });
      const pending = createDeferred<CronJob>();
      const request = vi.fn(async (method: string) =>
        method === "cron.get" ? pending.promise : { enabled: true, jobs: 1 },
      );
      const state = createStateWithRequest(request);
      startCronEdit(state, job);
      const read = loadCronStatus(state);
      expect(request).toHaveBeenCalledWith("cron.get", { id: job.id });
      if (change === "close and reopen") {
        cancelCronEdit(state, state.cronAgentId);
        startCronEdit(state, job);
      } else if (change === "agent") {
        state.cronAgentId = "other";
      } else if (change === "connection") {
        state.client = createStateWithRequest(request).client;
      } else {
        invalidateCronRefresh(state);
      }
      pending.resolve({ ...job, state: { triggerEvalCount: 99 } });
      await read;
      expect(state.cronEditingJob).toBe(job);
      expect(job.state.triggerEvalCount).toBe(1);
      expect(state.cronError).toBeNull();
    },
  );

  it.each([
    { operation: "save", method: "cron.get", readFirst: true, failWhileBusy: false },
    { operation: "run", method: "cron.status", readFirst: false, failWhileBusy: false },
    { operation: "save", method: "cron.get", readFirst: false, failWhileBusy: true },
    { operation: "toggle", method: "cron.status", readFirst: false, failWhileBusy: true },
  ] as const)(
    "preserves $operation feedback against $method (readFirst=$readFirst, failWhileBusy=$failWhileBusy)",
    async ({ operation, method: readMethod, readFirst, failWhileBusy }) => {
      const job = createCronJob("selected", "Saved", { state: {} });
      const pending = createDeferred<unknown>();
      const operationResponse = createDeferred<unknown>();
      const request = createMethodRequest({
        "cron.get": job,
        "cron.update": operationResponse.promise,
        "cron.run": operationResponse.promise,
        "cron.runs": { entries: [], total: 0, offset: 0, hasMore: false },
        "cron.status": { enabled: true, jobs: 1 },
        [readMethod]: pending.promise,
      });
      const state = createStateWithRequest(request);
      startCronEdit(state, job);
      const mutate = () =>
        operation === "save"
          ? addCronJob(state)
          : operation === "toggle"
            ? toggleCronJob(state, job, false)
            : runCronJob(state, job.id);
      const refresh = () => loadCronStatus(state, { coalesce: true });
      const read = readFirst ? refresh() : undefined;
      const firstQueued = readFirst ? refresh() : undefined;
      const mutation = mutate();
      const activeRead = read ?? refresh();
      expect(request).toHaveBeenCalledWith(
        readMethod,
        readMethod === "cron.get" ? { id: job.id } : {},
      );
      const queued = failWhileBusy ? Promise.resolve() : (firstQueued ?? refresh());
      if (failWhileBusy) {
        pending.reject(new Error("Background refresh failed"));
        await activeRead;
        expect(state.cronError).toBeNull();
      }
      if (operation === "run") {
        operationResponse.resolve({ ok: true, enqueued: true, runId: "queued-run" });
      } else {
        operationResponse.reject(new Error("Update rejected by Gateway"));
      }
      await mutation;
      const expectedFeedback =
        operation === "run" ? "Run queued. Run ID: queued-run" : "Update rejected by Gateway";
      expect(state.cronError).toBe(expectedFeedback);
      if (!failWhileBusy) {
        pending.reject(new Error("Older refresh failed"));
      }
      await Promise.all([activeRead, queued]);
      expect(state.cronError).toBe(expectedFeedback);
      expect(state.cronEditingJob).toBe(job);
    },
  );

  it("keeps final event data and the trailing refresh after Run now settles", async () => {
    const job = createCronJob("selected", "Saved", { state: { triggerEvalCount: 1 } });
    const runResponse = createDeferred<unknown>();
    const firstJob = createDeferred<CronJob>();
    const lastJob = createDeferred<CronJob>();
    const firstStatus = createDeferred<unknown>();
    let jobReads = 0;
    let statusReads = 0;
    const request = createMethodRequest(
      {
        "cron.run": runResponse.promise,
        "cron.runs": { entries: [], total: 0, offset: 0, hasMore: false },
      },
      {
        "cron.get": () => (++jobReads === 1 ? firstJob.promise : lastJob.promise),
        "cron.status": () =>
          ++statusReads === 1 ? firstStatus.promise : { enabled: true, jobs: 9 },
      },
    );
    const state = createStateWithRequest(request);
    startCronEdit(state, job);
    const mutation = runCronJob(state, job.id);
    const read = loadCronStatus(state, { coalesce: true });
    const queued = loadCronStatus(state, { coalesce: true });
    let queuedSettled = false;
    void queued.then(() => {
      queuedSettled = true;
    });
    runResponse.resolve({ ok: true, enqueued: true, runId: "queued-run" });
    await mutation;
    firstJob.resolve({ ...job, state: { triggerEvalCount: 7 } });
    firstStatus.resolve({ enabled: true, jobs: 7 });
    await read;
    expect(job.state.triggerEvalCount).toBe(7);
    expect(jobReads).toBe(2);
    expect(queuedSettled).toBe(false);
    lastJob.resolve({ ...job, state: { triggerEvalCount: 9 } });
    await queued;
    expect(job.state.triggerEvalCount).toBe(9);
    expect(state.cronStatus?.jobs).toBe(9);
    expect(state.cronError).toBe("Run queued. Run ID: queued-run");
  });

  it.each(["cron.get", "cron.status"] as const)(
    "keeps explicit reconciliation errors visible for %s with a queued event",
    async (failedMethod) => {
      const job = createCronJob("selected", "Saved", { state: {} });
      const failure = createDeferred<unknown>();
      let failedMethodReads = 0;
      const responses = {
        "cron.update": job,
        "cron.get": job,
        "cron.list": cronJobsListResponse([job]),
        "cron.status": { enabled: true, jobs: 1 },
      };
      const request = createMethodRequest(responses, {
        [failedMethod]: () =>
          ++failedMethodReads === 1 ? failure.promise : responses[failedMethod],
      });
      const state = createStateWithRequest(request);
      startCronEdit(state, job);
      const mutation = toggleCronJob(state, job, false);
      await vi.waitFor(() => expect(request).toHaveBeenCalledWith("cron.status", {}));
      expect(request).toHaveBeenCalledWith(
        failedMethod,
        failedMethod === "cron.get" ? { id: job.id } : {},
      );
      const queued = loadCronStatus(state, { coalesce: true });
      failure.reject(new Error("Reconciliation unavailable"));
      expect(await mutation).toBe(true);
      await queued;
      expect(state.cronError).toBe("Reconciliation unavailable");
    },
  );
});
