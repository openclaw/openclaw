// @vitest-environment node
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createStateWithRequest } from "./cron.test-support.ts";
import { getCronRunsViewState, loadCronRuns } from "./runs.ts";
import { loadCronStatus } from "./state.ts";
import type { CronState } from "./types.ts";

function createRefreshHarness(method: "cron.status" | "cron.runs") {
  const pending: Array<ReturnType<typeof createDeferred<unknown>>> = [];
  const request = vi.fn(() => {
    const response = createDeferred<unknown>();
    pending.push(response);
    return response.promise;
  });
  const state = createStateWithRequest(request);
  const loads: Promise<unknown>[] = [];
  const load = (coalesce = true) => {
    const read = method === "cron.status" ? loadCronStatus : loadCronRuns;
    const promise = read(state, { coalesce });
    loads.push(promise);
    return promise;
  };
  const payload = (revision: number) =>
    method === "cron.status"
      ? { enabled: true, triggersEnabled: true, jobs: revision }
      : {
          entries: [{ ts: revision, jobId: "job", action: "finished", status: "ok" }],
          total: 1,
          hasMore: false,
          nextOffset: null,
        };
  onTestFinished(async () => {
    state.connected = false;
    pending.forEach((response) => response.resolve(payload(0)));
    await Promise.all(loads);
  });
  return {
    state,
    request,
    response(index: number) {
      const response = pending[index];
      if (!response) {
        throw new Error(`No pending response at index ${index}`);
      }
      return response;
    },
    load,
    payload,
    seed(revision: number, page = {}) {
      const read = load(false);
      this.response(pending.length - 1).resolve({ ...payload(revision), ...page });
      return read;
    },
    settle: () => Promise.all(loads),
    error: () => (method === "cron.status" ? state.cronError : state.cronRunsError),
    revision: () => (method === "cron.status" ? state.cronStatus?.jobs : state.cronRuns[0]?.ts),
  };
}

describe.each(["cron.status", "cron.runs"] as const)("%s event refresh ownership", (method) => {
  it("publishes progress during sustained events while keeping one trailing reread", async () => {
    const harness = createRefreshHarness(method);
    const explicit = harness.load(false);
    for (let revision = 1; revision <= 3; revision += 1) {
      let queuedSettled = false;
      if (revision < 3) {
        for (let event = 0; event < 20; event += 1) {
          void harness.load().then(() => {
            queuedSettled = true;
          });
        }
      }
      expect(harness.request).toHaveBeenCalledTimes(revision);
      harness.response(revision - 1).resolve(harness.payload(revision));
      if (revision === 1) {
        await explicit;
        expect(queuedSettled).toBe(false);
      } else {
        await vi.waitFor(() => expect(harness.revision()).toBe(revision));
      }
      expect(harness.revision()).toBe(revision);
      if (revision < 3) {
        expect(harness.request).toHaveBeenCalledTimes(revision + 1);
      }
    }
    await harness.settle();
    expect(harness.error()).toBeNull();
  });

  it.each([true, false])(
    "keeps the latest error outcome when firstFails=%s",
    async (firstFails) => {
      const harness = createRefreshHarness(method);
      void harness.load();
      void harness.load();
      expect(harness.request).toHaveBeenCalledTimes(1);
      if (firstFails) {
        harness.response(0).reject(new Error("obsolete refresh failed"));
      } else {
        harness.response(0).resolve(harness.payload(1));
      }
      await vi.waitFor(() => expect(harness.request).toHaveBeenCalledTimes(2));
      expect(harness.error()).toBeNull();
      if (firstFails) {
        harness.response(1).resolve(harness.payload(2));
      } else {
        expect(harness.revision()).toBe(1);
        harness.response(1).reject(new Error("latest refresh failed"));
      }
      await harness.settle();
      expect(harness.revision()).toBe(firstFails ? 2 : 1);
      expect(harness.error()).toBe(firstFails ? null : "latest refresh failed");
    },
  );

  it("settles a queued refresh without dispatch when page read admission closes", async () => {
    const harness = createRefreshHarness(method);
    let visible = true;
    harness.state.canRefresh = () => visible;
    const initial = harness.load();
    const queued = harness.load();
    visible = false;
    harness.response(0).resolve(harness.payload(1));
    await Promise.all([initial, queued]);
    expect(harness.request).toHaveBeenCalledTimes(1);
    expect(harness.revision()).toBe(1);
    visible = true;
    const resumed = harness.load();
    expect(harness.request).toHaveBeenCalledTimes(2);
    harness.response(1).resolve(harness.payload(2));
    await resumed;
    expect(harness.revision()).toBe(2);
  });
});

it("requires a successful replacement page before appending after a failed refresh", async () => {
  const harness = createRefreshHarness("cron.runs");
  expect(getCronRunsViewState(harness.state)).toBe("idle");
  harness.state.cronRunsQuery = "new filter";
  await harness.seed(1, { total: 2, hasMore: true, nextOffset: 1 });
  const replacement = harness.load(false);
  expect(getCronRunsViewState(harness.state)).toBe("pending");
  expect(harness.revision()).toBe(1);
  harness.response(1).reject(new Error("History unavailable"));
  await replacement;
  expect(getCronRunsViewState(harness.state)).toBe("failed");
  expect(harness.revision()).toBe(1);
  expect(harness.error()).toBe("History unavailable");
  const append = loadCronRuns(harness.state, { append: true });
  expect(harness.request).toHaveBeenCalledTimes(2);
  await append;

  // Matching text must not let history recovery clear independent action feedback.
  harness.state.cronError = "History unavailable";
  const retry = harness.load(false);
  expect(getCronRunsViewState(harness.state)).toBe("pending");
  expect(harness.revision()).toBe(1);
  harness.response(2).resolve({ ...harness.payload(2), total: 2, hasMore: true, nextOffset: 1 });
  await retry;
  expect(getCronRunsViewState(harness.state)).toBe("ready");
  expect(harness.revision()).toBe(2);
  expect(harness.error()).toBeNull();
  expect(harness.state.cronError).toBe("History unavailable");
  const nextPage = loadCronRuns(harness.state, { append: true });
  expect(harness.request).toHaveBeenLastCalledWith(
    "cron.runs",
    expect.objectContaining({
      query: "new filter",
      offset: 1,
      view: "summary",
    }),
  );
  harness.response(3).resolve(harness.payload(3));
  await nextPage;
  expect(harness.state.cronRuns.map((entry) => entry.ts)).toEqual([2, 3]);
  const failedRefresh = harness.load(false);
  harness.response(4).reject(new Error("Previous history failed"));
  await failedRefresh;
  expect(harness.revision()).toBe(2);
  expect(harness.error()).toBe("Previous history failed");
  harness.state.cronRunsQuery = "another filter";
  const changed = harness.load(false);
  expect(harness.state.cronRuns).toEqual([]);
  expect(harness.state.cronRunsHasMore).toBe(false);
  expect(harness.state.cronRunsNextOffset).toBeNull();
  expect(harness.error()).toBeNull();
  harness.response(5).reject(new Error("Current history failed"));
  await changed;
  expect(harness.state.cronRuns).toEqual([]);
  expect(harness.error()).toBe("Current history failed");
});

it.each(["scope", "agent", "delivery", "job", "connection"] as const)(
  "supersedes queued reads after %s changes",
  async (change) => {
    const harness = createRefreshHarness("cron.runs");
    harness.state.cronRunsScope = "job";
    harness.state.cronRunsJobId = "first-job";
    await harness.seed(1);
    const initial = harness.load();
    const queued = harness.load();
    const patches = {
      scope: { cronRunsScope: "all" },
      agent: { cronAgentId: "writer" },
      delivery: { cronRunsDeliveryStatuses: ["not-delivered"] },
      job: { cronRunsJobId: "second-job" },
      connection: { client: { request: harness.request } as unknown as GatewayBrowserClient },
    } satisfies Record<string, Partial<CronState>>;
    Object.assign(harness.state, patches[change]);
    expect(getCronRunsViewState(harness.state)).toBe("idle");
    const current = harness.load();
    expect(getCronRunsViewState(harness.state)).toBe("pending");
    expect(harness.state.cronRuns).toEqual([]);
    expect(harness.request).toHaveBeenCalledTimes(3);
    harness.response(2).resolve(harness.payload(2));
    await current;
    expect(getCronRunsViewState(harness.state)).toBe("ready");
    harness.response(1).reject(new Error("superseded query failed"));
    await expect(initial).resolves.toBe("skipped");
    await expect(queued).resolves.toBe("skipped");
    expect(getCronRunsViewState(harness.state)).toBe("ready");
    expect(harness.request).toHaveBeenCalledTimes(3);
    expect(harness.revision()).toBe(2);
    expect(harness.error()).toBeNull();
  },
);
