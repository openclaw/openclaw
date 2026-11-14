import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventFrame, GatewayHelloOk } from "../../api/gateway.ts";
import type { CronCompactJob, CronJobsListResult } from "../../api/types.ts";
import { page as cronRoute } from "../../pages/cron/route.tsx";
import {
  createApplicationGateway,
  createApplicationGatewaySnapshot,
} from "../../test-helpers/application-context-fixtures.ts";
import {
  createCronJob,
  compactCronJobFixture,
  cronJobsListResponse,
} from "../../test-helpers/cron.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import {
  bindCronInventory,
  clearCronInventory,
  receiveCronInventoryEvent,
} from "./inventory-connection.ts";
import { readCronInventory } from "./inventory.ts";
import { loadCronJobsPage } from "./jobs-full.ts";
import { createInitialCronState } from "./state.ts";

const hello: GatewayHelloOk = {
  type: "hello-ok",
  protocol: 4,
  auth: { role: "operator", scopes: ["operator.read"] },
  features: { events: ["cron.inventory.changed"] },
};
const query = {
  compact: true,
  sessionKey: "agent:ops:task",
  sessionAgentId: "ops",
  includeDisabled: true,
  includeDeliveryPreviews: false,
  limit: 50,
  offset: 0,
  sortBy: "name",
  sortDir: "asc",
} as const;
const fullJob = createCronJob("held", "Held automation", { agentId: "ops" });
const page = (
  jobs: CronCompactJob[] = [compactCronJobFixture(fullJob)],
): CronJobsListResult<CronCompactJob> => ({ ...cronJobsListResponse(), jobs, total: jobs.length });
const changed: GatewayEventFrame = { type: "event", event: "cron.inventory.changed" };
const clients: GatewayBrowserClient[] = [];
function fixture(request = createGatewayRequestMock(async () => page()), advertised = true) {
  const client = createTestGatewayClient(request);
  clients.push(client);
  bindCronInventory(client, advertised ? hello : { ...hello, features: { events: [] } });
  return { client, request };
}
function runtime(
  jobId: string,
  action: "started" | "finished",
  updatedAtMs: number,
): GatewayEventFrame {
  return {
    type: "event",
    event: "cron",
    payload: {
      jobId,
      action,
      job: {
        id: jobId,
        name: "Held automation",
        agentId: "ops",
        enabled: true,
        updatedAtMs,
        state:
          action === "started"
            ? { runningAtMs: updatedAtMs }
            : { lastRunAtMs: updatedAtMs, lastRunStatus: "ok" },
      },
    },
  };
}
afterEach(() => {
  clients.splice(0).forEach(clearCronInventory);
  vi.useRealTimers();
});

function routeLoad(
  client: GatewayBrowserClient,
  options: {
    advertised?: boolean;
    search?: string;
    cause?: "navigation" | "preload";
    signal?: AbortSignal;
  } = {},
) {
  const gateway = createApplicationGateway(
    createApplicationGatewaySnapshot({
      client,
      phase: "connected",
      hello: options.advertised === false ? { ...hello, features: { events: [] } } : hello,
    }),
  ).gateway;
  return cronRoute.loader!(
    { gateway, agentSelection: { state: { selectedId: "ops", scopeId: "ops" } } },
    {
      deps: options.search ?? "",
      location: { pathname: "/automations", search: options.search ?? "", hash: "" },
      cause: options.cause ?? "navigation",
      signal: options.signal ?? new AbortController().signal,
      shouldRun: () => true,
      revalidating: false,
    },
  );
}

it("starts the default Cron inventory during navigation and shares it with the page", async () => {
  const response = Promise.withResolvers<CronJobsListResult>();
  const { client, request } = fixture(createGatewayRequestMock(async () => response.promise));
  const controller = new AbortController();
  expect(routeLoad(client, { signal: controller.signal })).toBe("");
  expect(request).toHaveBeenCalledTimes(1);
  const state = createInitialCronState({ client, connected: true });
  state.cronAgentId = "ops";
  const loaded = loadCronJobsPage(state, { tableFilters: true });
  controller.abort();
  response.resolve(cronJobsListResponse([fullJob]));
  await loaded;
  expect(state.cronJobs).toEqual([fullJob]);
  expect(request).toHaveBeenCalledTimes(1);
});

it("keeps one page-owned read on Gateways without shared inventory support", async () => {
  const { client, request } = fixture(
    createGatewayRequestMock(async () => cronJobsListResponse([fullJob])),
    false,
  );
  expect(routeLoad(client, { advertised: false })).toBe("");
  expect(request).not.toHaveBeenCalled();
  const state = createInitialCronState({ client, connected: true });
  state.cronAgentId = "ops";
  await loadCronJobsPage(state, { tableFilters: true });
  expect(state.cronJobs).toEqual([fullJob]);
  expect(request).toHaveBeenCalledTimes(1);
});

it("does not continue an abandoned Cron navigation after inventory invalidation", async () => {
  vi.useFakeTimers();
  const { client, request } = fixture(
    createGatewayRequestMock(async () => cronJobsListResponse([fullJob])),
  );
  receiveCronInventoryEvent(client, changed);
  const controller = new AbortController();
  expect(routeLoad(client, { signal: controller.signal })).toBe("");
  expect(request).not.toHaveBeenCalled();
  controller.abort();
  await vi.advanceTimersByTimeAsync(50);
  expect(request).not.toHaveBeenCalled();

  const state = createInitialCronState({ client, connected: true });
  state.cronAgentId = "ops";
  await loadCronJobsPage(state, { tableFilters: true });
  expect(state.cronJobs).toEqual([fullJob]);
  expect(request).toHaveBeenCalledTimes(1);
});

it.each([{ cause: "preload" as const }, { search: "?job=held" }, { signal: AbortSignal.abort() }])(
  "does not warm an optional or retired Cron route: %j",
  (options) => {
    const { client, request } = fixture();
    expect(routeLoad(client, options)).toBe(options.search ?? "");
    expect(request).not.toHaveBeenCalled();
  },
);

it("stops paging when every inventory reader becomes hidden", async () => {
  const response = Promise.withResolvers<CronJobsListResult<CronCompactJob>>();
  const { client, request } = fixture(createGatewayRequestMock(async () => response.promise));
  let visible = true;
  const result = readCronInventory(client, query, { canRead: () => visible });
  visible = false;
  response.resolve({
    ...page(
      Array.from({ length: 200 }, (_, index) => ({
        ...compactCronJobFixture(fullJob),
        id: String(index),
      })),
    ),
    limit: 200,
    total: 201,
    hasMore: true,
    nextOffset: 200,
  });
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(request).toHaveBeenCalledTimes(1);
});

it("preserves loaded pages during runtime updates and resets them for a new query", async () => {
  const jobs = ["A", "B", "C"].map((id) => createCronJob(id, `Job ${id}`));
  const { client, request } = fixture(
    createGatewayRequestMock(async () => cronJobsListResponse(jobs)),
  );
  const state = createInitialCronState({ client, connected: true });
  state.cronJobsLimit = 1;
  state.cronJobsSortBy = "name";
  await loadCronJobsPage(state);
  await loadCronJobsPage(state, { append: true });
  expect(state.cronJobs.map((job) => job.id)).toEqual(["A", "B"]);
  const event = runtime("C", "started", jobs[2]!.updatedAtMs + 1);
  receiveCronInventoryEvent(client, event);
  await loadCronJobsPage(state, { event: event.payload });
  expect(state.cronJobs.map((job) => job.id)).toEqual(["A", "B"]);
  expect(state.cronJobsNextOffset).toBe(2);
  expect(request).toHaveBeenCalledTimes(1);
  state.cronJobsQuery = "Job";
  await loadCronJobsPage(state);
  expect(state.cronJobs).toHaveLength(1);
  expect(request).toHaveBeenCalledTimes(2);
});

it.each(["runtime", "definition"] as const)(
  "settles a paged inventory across a %s change",
  async (change) => {
    vi.useFakeTimers();
    const jobs = Array.from({ length: 201 }, (_, index) => ({
      ...compactCronJobFixture(fullJob),
      id: String(index),
      name: `Job ${String(index).padStart(3, "0")}`,
    }));
    const second = Promise.withResolvers<CronJobsListResult<CronCompactJob>>();
    const entered = Promise.withResolvers<void>();
    let calls = 0;
    const { client, request } = fixture(
      createGatewayRequestMock(async () => {
        calls += 1;
        if (calls === 1) {
          return {
            ...page(jobs.slice(0, 200)),
            limit: 200,
            total: 201,
            hasMore: true,
            nextOffset: 200,
          };
        }
        if (calls === 2) {
          entered.resolve();
          return second.promise;
        }
        return page([]);
      }),
    );
    const read = readCronInventory(client, query);
    await entered.promise;
    const definition = change === "definition";
    const updatedAt = fullJob.updatedAtMs + 1;
    receiveCronInventoryEvent(client, definition ? changed : runtime("0", "started", updatedAt));
    second.resolve(
      definition
        ? page([])
        : {
            ...page(jobs.slice(200)),
            offset: 200,
            limit: 200,
            total: 201,
            snapshotRevision: "after-runtime",
          },
    );
    await vi.advanceTimersByTimeAsync(50);
    const result = await read;
    expect(result.total).toBe(definition ? 0 : 201);
    expect(result.jobs[0]?.runningAtMs).toBe(definition ? undefined : updatedAt);
    expect(request).toHaveBeenCalledTimes(definition ? 3 : 2);
  },
);

it("shares accepted/in-flight inventories only for the same connection and query", async () => {
  const response = Promise.withResolvers<CronJobsListResult<CronCompactJob>>();
  const { client, request } = fixture(createGatewayRequestMock(async () => response.promise));
  const other = fixture();
  const first = readCronInventory(client, query);
  const joined = readCronInventory(client, { ...query });
  const otherScope = readCronInventory(client, { ...query, sessionKey: "agent:ops:other" });
  await readCronInventory(other.client, query);
  expect(request).toHaveBeenCalledTimes(2);
  response.resolve(page());
  const result = await first;
  expect(await joined).toEqual(result);
  await otherScope;
  expect(await readCronInventory(client, query)).toEqual(result);
  expect(request).toHaveBeenCalledTimes(2);
  expect(other.request).toHaveBeenCalledTimes(1);
});

it("ignores unrelated run churn and keeps known runtime facts without rereads", async () => {
  const { client, request } = fixture();
  const accepted = await readCronInventory(client, query);
  for (let index = 0; index < 60; index += 1) {
    receiveCronInventoryEvent(
      client,
      runtime("unrelated", index % 2 ? "finished" : "started", index + 1),
    );
    expect(await readCronInventory(client, query)).toEqual(accepted);
  }
  receiveCronInventoryEvent(client, runtime("held", "started", 61));
  expect((await readCronInventory(client, query)).jobs[0]?.runningAtMs).toBe(61);
  receiveCronInventoryEvent(client, runtime("held", "finished", 62));
  const finished = (await readCronInventory(client, query)).jobs[0];
  expect(finished?.runningAtMs).toBeUndefined();
  expect(finished?.lastRunStatus).toBe("ok");
  expect(request).toHaveBeenCalledTimes(1);
});

it("derives runtime-filtered pages from complete admitted membership without a list read", async () => {
  const first = createCronJob("first", "First", {
    agentId: "ops",
    state: { lastRunStatus: "ok", nextRunAtMs: 10 },
  });
  const second = createCronJob("second", "Second", {
    agentId: "ops",
    state: { lastRunStatus: "error", nextRunAtMs: 20 },
  });
  const { client, request } = fixture(
    createGatewayRequestMock(async () => cronJobsListResponse([first, second])),
  );
  const filtered = {
    ...query,
    compact: false,
    limit: 1,
    sortBy: "nextRunAtMs",
    lastRunStatus: "ok",
  } as const;
  expect((await readCronInventory(client, filtered)).jobs.map((job) => job.id)).toEqual(["first"]);
  receiveCronInventoryEvent(client, {
    type: "event",
    event: "cron",
    payload: {
      action: "finished",
      jobId: "second",
      job: { ...second, updatedAtMs: 2, state: { lastRunStatus: "ok", nextRunAtMs: 1 } },
    },
  });
  const updated = await readCronInventory(client, filtered);
  expect(updated.jobs.map((job) => job.id)).toEqual(["second"]);
  expect(updated.total).toBe(2);
  expect(
    (await readCronInventory(client, { ...filtered, offset: 1 })).jobs.map((job) => job.id),
  ).toEqual(["first"]);
  expect((await readCronInventory(client, { ...filtered, lastRunStatus: "error" })).total).toBe(0);
  expect((await readCronInventory(client, { ...filtered, enabled: "disabled" })).total).toBe(0);
  expect(request).toHaveBeenCalledTimes(1);
});

it("absorbs definition bursts during a read and publishes only the trailing authority", async () => {
  vi.useFakeTimers();
  const response = Promise.withResolvers<CronJobsListResult<CronCompactJob>>();
  const request = createGatewayRequestMock()
    .mockResolvedValueOnce(response.promise)
    .mockResolvedValue(page([]));
  const { client } = fixture(request);
  const first = readCronInventory(client, query);
  for (let index = 0; index < 3; index += 1) {
    receiveCronInventoryEvent(client, changed);
  }
  const joined = readCronInventory(client, query);
  response.resolve(page());
  await vi.advanceTimersByTimeAsync(50);
  expect((await first).jobs).toEqual([]);
  expect((await joined).jobs).toEqual([]);
  expect(request).toHaveBeenCalledTimes(2);
});

it("retires cached visibility when the connection's profile access changes", async () => {
  vi.useFakeTimers();
  const request = createGatewayRequestMock()
    .mockResolvedValueOnce(page())
    .mockResolvedValue(page([]));
  const { client } = fixture(request);
  expect((await readCronInventory(client, query)).jobs).toHaveLength(1);
  receiveCronInventoryEvent(client, {
    type: "event",
    event: "sessions.changed",
    payload: { reason: "profile-identity" },
  });
  const current = readCronInventory(client, query);
  await vi.advanceTimersByTimeAsync(50);
  expect((await current).jobs).toEqual([]);
  expect(request).toHaveBeenCalledTimes(2);
});

it("rechecks presentation after the debounce and catches up when shown", async () => {
  vi.useFakeTimers();
  const { client, request } = fixture();
  await readCronInventory(client, query);
  receiveCronInventoryEvent(client, changed);
  let shown = true;
  const pending = readCronInventory(client, query, { canRead: () => shown });
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  shown = false;
  await vi.advanceTimersByTimeAsync(50);
  await rejected;
  expect(request).toHaveBeenCalledTimes(1);
  shown = true;
  await readCronInventory(client, query, { canRead: () => shown });
  expect(request).toHaveBeenCalledTimes(2);
});

it("lets one consumer cancel without cancelling a sibling's inventory", async () => {
  const response = Promise.withResolvers<CronJobsListResult<CronCompactJob>>();
  const { client, request } = fixture(createGatewayRequestMock(async () => response.promise));
  const controller = new AbortController();
  const cancelled = readCronInventory(client, query, { signal: controller.signal });
  const sibling = readCronInventory(client, query);
  const rejected = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  await rejected;
  response.resolve(page());
  expect((await sibling).jobs[0]?.id).toBe("held");
  expect(request).toHaveBeenCalledTimes(1);
});

it("retires late responses and cached results with the connection's admitted hello", async () => {
  const response = Promise.withResolvers<CronJobsListResult<CronCompactJob>>();
  const request = createGatewayRequestMock()
    .mockResolvedValueOnce(response.promise)
    .mockResolvedValue(page([]));
  const { client } = fixture(request);
  const stale = readCronInventory(client, query);
  const rejected = expect(stale).rejects.toMatchObject({ name: "AbortError" });
  bindCronInventory(client, { ...hello });
  response.resolve(page());
  await rejected;
  expect((await readCronInventory(client, query)).jobs).toEqual([]);
  expect(request).toHaveBeenCalledTimes(2);
});

it("retains uncached reads and legacy palette invalidation on unadvertised Gateways", async () => {
  const { client, request } = fixture(undefined, false);
  await readCronInventory(client, query);
  await readCronInventory(client, query);
  expect(request).toHaveBeenCalledTimes(2);
  await readCronInventory(client, query, { legacyCache: true });
  await readCronInventory(client, query, { legacyCache: true });
  expect(request).toHaveBeenCalledTimes(3);
  receiveCronInventoryEvent(client, runtime("unknown", "started", 1));
  await readCronInventory(client, query, { legacyCache: true });
  expect(request).toHaveBeenCalledTimes(4);
});
