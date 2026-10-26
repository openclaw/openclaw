// @vitest-environment node
import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createRequireRecord } from "../../../../test/helpers/record.js";
import type { CronJob, CronJobsListResult, CronRunsResult } from "../../api/types.ts";
import {
  createCronRunsResult,
  createCronJob,
  cronJobsListResponse,
} from "../../test-helpers/cron.ts";
import { createMethodRequest, createStateWithRequest } from "./cron.test-support.ts";
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

const requireRecord = createRequireRecord("record", "expected-label-record");

function runEntry(jobId: string, ts: number) {
  return { ts, jobId, action: "finished", status: "ok" } as const;
}

describe("cron controller", () => {
  it("retires protected inventory and queued page reloads after a forbidden read", async () => {
    const pending = createDeferred<CronJobsListResult>();
    const request = vi.fn(() => pending.promise);
    const state = createStateWithRequest(request, {
      cronJobs: [createCronJob("private-job", "Private job")],
      cronJobsSnapshotRevision: "private-snapshot",
      cronJobsTotal: 2,
      cronJobsHasMore: true,
      cronJobsNextOffset: 1,
    });
    const read = loadCronJobsPage(state, { append: true });
    await loadCronJobsPage(state);
    pending.reject(
      new GatewayProtocolRequestError({ code: "FORBIDDEN", message: "Read authority revoked" }),
    );
    await read;
    expect(state.cronJobs).toEqual([]);
    expect(state.cronJobsSnapshotRevision).toBeNull();
    expect(state.cronJobsTotal).toBe(0);
    expect(state.cronJobsHasMore).toBe(false);
    expect(state.cronJobsNextOffset).toBeNull();
    expect(state.cronJobsReloadPending).toBe(false);
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([false, true])("appends from the accepted snapshot (changed=%s)", async (changed) => {
    const stale = createCronJob("stale", "Stale");
    const stable = createCronJob("stable", "Stable");
    const current = createCronJob("current", "Current");
    const page = (jobs: CronJob[], revision: string, overrides: Partial<CronJobsListResult> = {}) =>
      cronJobsListResponse(jobs, { snapshotRevision: revision, limit: 2, ...overrides });
    const responses = [
      page([stale, stable], "revision-a", { total: 3, hasMore: true, nextOffset: 2 }),
      page(changed ? [] : [current], changed ? "revision-b" : "revision-a", {
        total: changed ? 2 : 3,
        offset: 2,
      }),
      ...(changed ? [page([stable, current], "revision-b")] : []),
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
    expect(offsets).toEqual(changed ? [0, 2, 0] : [0, 2]);
    expect(state.cronJobs.map((job) => job.id)).toEqual(
      changed ? ["stable", "current"] : ["stale", "stable", "current"],
    );
    expect(state.cronJobsSnapshotRevision).toBe(changed ? "revision-b" : "revision-a");
    expect(state.cronJobsTotal).toBe(changed ? 2 : 3);
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
    const first = createDeferred<CronJobsListResult>();
    const payloads: unknown[] = [];
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method !== "cron.list") {
        return {};
      }
      payloads.push(payload);
      return payloads.length === 1 ? first.promise : cronJobsListResponse();
    });
    const state = createStateWithRequest(
      request,
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

  it("drops an older append after replacing history filters", async () => {
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
    updateCronRunsFilter(state, { cronRunsStatuses: ["error"], cronRunsQuery: "filtered" });
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
  });
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
    ["save", "cron.get", true, false, false],
    ["run", "cron.status", false, false, false],
    ["save", "cron.get", false, true, false],
    ["toggle", "cron.status", false, true, false],
    ["toggle", "cron.get", false, false, true],
    ["toggle", "cron.status", false, false, true],
  ] as const)(
    "preserves %s feedback against %s (readFirst=%s, failWhileBusy=%s, explicit=%s)",
    async (operation, readMethod, readFirst, failWhileBusy, explicit) => {
      const job = createCronJob("selected", "Saved", { state: {} });
      const pending = createDeferred<unknown>();
      const operationResponse = createDeferred<unknown>();
      let reads = 0;
      const request = createMethodRequest(
        {
          "cron.get": job,
          "cron.update": operationResponse.promise,
          "cron.run": operationResponse.promise,
          "cron.runs": { entries: [], total: 0, offset: 0, hasMore: false },
          "cron.list": cronJobsListResponse([job]),
          "cron.status": { enabled: true, jobs: 1 },
        },
        {
          [readMethod]: () =>
            !explicit || reads++ === 0
              ? pending.promise
              : readMethod === "cron.get"
                ? job
                : { enabled: true, jobs: 1 },
        },
      );
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
      if (explicit) {
        operationResponse.resolve(job);
        await vi.waitFor(() => expect(request).toHaveBeenCalledWith("cron.status", {}));
        const queued = refresh();
        pending.reject(new Error("Reconciliation unavailable"));
        expect(await mutation).toBe(true);
        await queued;
        expect(state.cronError).toBe("Reconciliation unavailable");
        return;
      }
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
      expect(state[operation === "run" ? "cronNotice" : "cronError"]).toBe(expectedFeedback);
      if (!failWhileBusy) {
        pending.reject(new Error("Older refresh failed"));
      }
      await Promise.all([activeRead, queued]);
      expect(state[operation === "run" ? "cronNotice" : "cronError"]).toBe(expectedFeedback);
      expect(state.cronEditingJob).toBe(job);
    },
  );
});
