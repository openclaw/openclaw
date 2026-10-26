import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { CronListParams } from "../../../../packages/gateway-protocol/src/schema/cron.types.ts";
import { sortCronJobs } from "../../../../src/cron/service/list-page-sort.ts";
import {
  readCanonicalCronListPage,
  resolveCronListPageNextOffset,
} from "../../../../src/cron/service/list-page-validation.ts";
import type { GatewayBrowserClient, GatewayEventFrame, GatewayHelloOk } from "../../api/gateway.ts";
import type { CronCompactJob, CronJob, CronJobsListResult } from "../../api/types.ts";
import { subscribeToSharedRequest } from "../shared-request-subscription.ts";

const INVENTORY_CHANGED = "cron.inventory.changed";
const inventories = new WeakMap<GatewayBrowserClient, Inventory>();
type Runtime = {
  revision: number;
  jobId: string;
  action: "started" | "finished" | "scheduled";
  job: Pick<CronJob, "id" | "name" | "agentId" | "enabled" | "updatedAtMs" | "state">;
  error?: string;
  durationMs?: number;
};
type Subscriber = { canRead: () => boolean };
type Entry<Row> = {
  params: CronListParams;
  version: number;
  value?: CronJobsListResult<Row>;
  pending?: {
    promise: Promise<CronJobsListResult<Row>>;
    controller: AbortController;
    subscribers: Set<Subscriber>;
  };
};
type Inventory = {
  hello: GatewayHelloOk | null;
  supported: boolean;
  version: number;
  compact: Map<string, Entry<CronCompactJob>>;
  full: Map<string, Entry<CronJob>>;
  runtime: Map<string, Runtime>;
  runtimeRevision: number;
  debounce?: { promise: Promise<void>; resolve: () => void; timer: ReturnType<typeof setTimeout> };
};

export function hasCronInventoryEvents(snapshot: { hello?: GatewayHelloOk | null }): boolean {
  return snapshot.hello?.features?.events?.includes(INVENTORY_CHANGED) === true;
}

export function usesCronInventoryEvents(client: GatewayBrowserClient): boolean {
  return inventories.get(client)?.supported === true;
}

export function isCronInventoryInvalidation(
  event: GatewayEventFrame,
  snapshot: { hello?: GatewayHelloOk | null },
): boolean {
  return (
    event.event === INVENTORY_CHANGED ||
    event.event === "config.changed" ||
    (event.event === "sessions.changed" &&
      isRecord(event.payload) &&
      ["sharing", "delete", "reset", "archive"].includes(String(event.payload.reason))) ||
    (event.event === "cron" && !hasCronInventoryEvents(snapshot))
  );
}

/** Hello and disconnect publications retire data before any consumer can reuse it. */
export function bindCronInventory(client: GatewayBrowserClient, hello: GatewayHelloOk | null) {
  if (inventories.get(client)?.hello === hello) {
    return;
  }
  clearCronInventory(client);
  inventories.set(client, {
    hello,
    supported: hasCronInventoryEvents({ hello }),
    version: 0,
    compact: new Map(),
    full: new Map(),
    runtime: new Map(),
    runtimeRevision: 0,
  });
}

export function clearCronInventory(client: GatewayBrowserClient): void {
  const owner = inventories.get(client);
  inventories.delete(client);
  if (owner?.debounce) {
    clearTimeout(owner.debounce.timer);
    owner.debounce.resolve();
  }
  for (const entry of [...(owner?.compact.values() ?? []), ...(owner?.full.values() ?? [])]) {
    entry.pending?.controller.abort();
  }
}

export function invalidateCronInventory(client: GatewayBrowserClient): void {
  const owner = inventories.get(client);
  if (!owner) {
    return;
  }
  owner.version += 1;
  owner.runtime.clear();
  if (owner.supported && !owner.debounce) {
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(() => {
      owner.debounce = undefined;
      resolve();
    }, 50);
    owner.debounce = { promise, resolve, timer };
  }
}

/** Called once by the Gateway event owner, before events reach view subscribers. */
export function receiveCronInventoryEvent(client: GatewayBrowserClient, event: GatewayEventFrame) {
  const owner = inventories.get(client);
  if (!owner) {
    return;
  }
  if (isCronInventoryInvalidation(event, { hello: owner.hello })) {
    invalidateCronInventory(client);
  } else if (owner.supported && event.event === "cron") {
    const payload = event.payload;
    if (
      !isRecord(payload) ||
      !["started", "finished", "scheduled"].includes(String(payload.action)) ||
      !isRecord(payload.job) ||
      !isRecord(payload.job.state) ||
      payload.jobId !== payload.job.id
    ) {
      return;
    }
    // SAFETY: The authenticated cron publisher owns this bounded runtime projection.
    const runtime = {
      ...(payload as Omit<Runtime, "revision">),
      revision: ++owner.runtimeRevision,
    };
    owner.runtime.delete(runtime.jobId);
    owner.runtime.set(runtime.jobId, runtime);
    // Keep only recent run facts for responses crossing an event; definitions retire them.
    if (owner.runtime.size > 512) {
      owner.runtime.delete(owner.runtime.keys().next().value!);
    }
    for (const entry of owner.compact.values()) {
      if (entry.value) {
        entry.value = updateCompact(entry.value, runtime);
      }
    }
    for (const entry of owner.full.values()) {
      if (entry.value) {
        entry.value = updateFull(entry.value, runtime, entry.params);
      }
    }
  }
}

function updateFull(page: CronJobsListResult, event: Runtime, params: CronListParams) {
  const index = page.jobs.findIndex((job) => job.id === event.jobId);
  const previous = page.jobs[index];
  if (!previous || previous.updatedAtMs > event.job.updatedAtMs) {
    return page;
  }
  const jobs = page.jobs.with(index, {
    ...previous,
    updatedAtMs: event.job.updatedAtMs,
    state: {
      ...previous.state,
      nextRunAtMs: event.job.state.nextRunAtMs,
      lastRunAtMs: event.job.state.lastRunAtMs,
      lastRunStatus: event.job.state.lastRunStatus,
      lastStatus: event.job.state.lastStatus,
      runningAtMs: event.job.state.runningAtMs,
      autoDisabled: event.job.state.autoDisabled,
      lastDurationMs: event.job.state.lastDurationMs,
      lastMeaningfulResult: event.job.state.lastMeaningfulResult,
      lastTriggerEvalAtMs: event.job.state.lastTriggerEvalAtMs,
      ...(event.action === "finished"
        ? { lastError: event.error, lastDurationMs: event.durationMs }
        : {}),
    },
  });
  return {
    ...page,
    snapshotRevision: `runtime:${event.revision}`,
    jobs:
      params.sortBy === "name"
        ? jobs
        : sortCronJobs(jobs, params.sortBy ?? "nextRunAtMs", params.sortDir ?? "asc"),
  };
}

function updateCompact(page: CronJobsListResult<CronCompactJob>, event: Runtime) {
  const index = page.jobs.findIndex((job) => job.id === event.jobId);
  const previous = page.jobs[index];
  if (!previous || previous.updatedAtMs > event.job.updatedAtMs) {
    return page;
  }
  const runtime = event.job.state;
  return {
    ...page,
    snapshotRevision: `runtime:${event.revision}`,
    jobs: page.jobs.with(index, {
      ...previous,
      updatedAtMs: event.job.updatedAtMs,
      nextRunAt: timestampMsToIsoString(runtime.nextRunAtMs) ?? null,
      nextRunAtMs: runtime.nextRunAtMs ?? null,
      lastRunAt: timestampMsToIsoString(runtime.lastRunAtMs) ?? null,
      lastRunAtMs: runtime.lastRunAtMs ?? null,
      lastRunStatus: runtime.lastRunStatus ?? runtime.lastStatus ?? null,
      runningAtMs: runtime.runningAtMs,
      autoDisabled: runtime.autoDisabled,
      lastDurationMs: runtime.lastDurationMs,
      lastMeaningfulResult: runtime.lastMeaningfulResult,
      lastTriggerEvalAtMs: runtime.lastTriggerEvalAtMs,
      ...(event.action === "finished"
        ? { lastRunError: event.error ?? null, lastDurationMs: event.durationMs }
        : {}),
    }),
  };
}

type ReadOptions = {
  refresh?: boolean;
  signal?: AbortSignal;
  canRead?: () => boolean;
  legacyCache?: boolean;
};
type CompactParams = CronListParams & { compact: true };
type FullParams = CronListParams & { compact?: false };

export function readCronInventory(
  client: GatewayBrowserClient,
  params: CompactParams,
  options?: ReadOptions,
): Promise<CronJobsListResult<CronCompactJob>>;
export function readCronInventory(
  client: GatewayBrowserClient,
  params: FullParams,
  options?: ReadOptions,
): Promise<CronJobsListResult>;
export function readCronInventory(
  client: GatewayBrowserClient,
  params: CronListParams,
  options: ReadOptions = {},
) {
  options.signal?.throwIfAborted();
  let owner = inventories.get(client);
  if (!owner) {
    bindCronInventory(client, null);
    owner = inventories.get(client)!;
  }
  if (!owner.supported && !options.legacyCache) {
    return options.signal
      ? client.request<CronJobsListResult | CronJobsListResult<CronCompactJob>>(
          "cron.list",
          params,
          { signal: options.signal },
        )
      : client.request<CronJobsListResult | CronJobsListResult<CronCompactJob>>(
          "cron.list",
          params,
        );
  }
  const source = {
    params: owner.supported ? inventoryQuery(params) : params,
    complete: owner.supported,
  };
  return params.compact
    ? readRows(
        client,
        owner,
        owner.compact,
        source.params,
        source.complete,
        updateCompact,
        options,
      ).then((page) =>
        source.complete
          ? selectPage(
              page,
              params,
              (job) => job.lastRunStatus,
              (jobs) =>
                sortCronJobs(
                  jobs.map((job) => ({
                    id: job.id,
                    name: job.name,
                    updatedAtMs: job.updatedAtMs,
                    state: { nextRunAtMs: job.nextRunAtMs ?? undefined },
                    job,
                  })),
                  params.sortBy ?? "nextRunAtMs",
                  params.sortDir ?? "asc",
                ).map(({ job }) => job),
            )
          : page,
      )
    : readRows(client, owner, owner.full, source.params, source.complete, updateFull, options).then(
        (page) =>
          source.complete
            ? selectPage(
                page,
                params,
                (job) => job.state.lastRunStatus ?? job.state.lastStatus,
                (jobs) =>
                  sortCronJobs(jobs, params.sortBy ?? "nextRunAtMs", params.sortDir ?? "asc"),
              )
            : page,
      );
}

function inventoryQuery(params: CronListParams) {
  return {
    ...params,
    compact: params.compact === true,
    enabled: "all" as const,
    includeDisabled: true,
    includeDeliveryPreviews: params.compact ? false : (params.includeDeliveryPreviews ?? true),
    query: params.query?.trim() || undefined,
    scheduleKind: params.scheduleKind ?? "all",
    trigger: params.trigger ?? "all",
    sortBy: "name" as const,
    sortDir: "asc" as const,
    lastRunStatus: "all" as const,
    limit: 200,
    offset: 0,
  };
}

function queryKey(params: CronListParams, complete: boolean) {
  return JSON.stringify([
    complete,
    Object.keys(params)
      .sort()
      .filter((key) => Reflect.get(params, key) !== undefined)
      .map((key) => [key, Reflect.get(params, key)]),
  ]);
}

/** Runtime cannot introduce membership; the canonical scope includes every runtime-filter candidate. */
export function cronInventoryHasJob(
  client: GatewayBrowserClient,
  params: CronListParams,
  payload: unknown,
): boolean {
  if (
    !isRecord(payload) ||
    typeof payload.jobId !== "string" ||
    !["started", "finished", "scheduled"].includes(String(payload.action))
  ) {
    return false;
  }
  const owner = inventories.get(client);
  const source = inventoryQuery(params);
  const key = queryKey(source, true);
  const page = params.compact ? owner?.compact.get(key)?.value : owner?.full.get(key)?.value;
  return page?.jobs.some((job) => job.id === payload.jobId) === true;
}

function selectPage<Row extends { enabled: boolean }>(
  page: CronJobsListResult<Row>,
  params: CronListParams,
  status: (row: Row) => string | null | undefined,
  sort: (rows: Row[]) => Row[],
): CronJobsListResult<Row> {
  const wanted = params.lastRunStatus;
  const enabled = params.enabled ?? (params.includeDisabled ? "all" : "enabled");
  const jobs = sort(
    page.jobs.filter(
      (job) =>
        (enabled === "all" || job.enabled === (enabled === "enabled")) &&
        (!wanted || wanted === "all" || (status(job) ?? "unknown") === wanted),
    ),
  );
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 50;
  const next = Math.min(jobs.length, offset + limit);
  return {
    ...page,
    jobs: jobs.slice(offset, next),
    total: jobs.length,
    offset,
    limit,
    hasMore: next < jobs.length,
    nextOffset: next < jobs.length ? next : null,
  };
}

function readRows<Row>(
  client: GatewayBrowserClient,
  owner: Inventory,
  entries: Map<string, Entry<Row>>,
  params: CronListParams,
  complete: boolean,
  update: (
    page: CronJobsListResult<Row>,
    event: Runtime,
    params: CronListParams,
  ) => CronJobsListResult<Row>,
  options: ReadOptions,
): Promise<CronJobsListResult<Row>> {
  const key = queryKey(params, complete);
  let entry = entries.get(key);
  if (!entry) {
    entry = { params, version: -1 };
    entries.set(key, entry);
    if (entries.size > 128) {
      entries.delete(entries.keys().next().value!);
    }
  }
  const current = entry;
  const subscriber = {
    canRead: options.canRead ?? (() => globalThis.document?.visibilityState !== "hidden"),
  };
  if (!options.refresh && current.version === owner.version && current.value) {
    return Promise.resolve(current.value);
  }
  if (current.pending) {
    return subscribeToSharedRequest(current.pending, subscriber, options.signal);
  }
  {
    const { promise, resolve, reject } = Promise.withResolvers<CronJobsListResult<Row>>();
    const pending = {
      controller: new AbortController(),
      subscribers: new Set([subscriber]),
      promise,
    };
    current.pending = pending;
    const assertPresented = () => {
      pending.controller.signal.throwIfAborted();
      if (
        inventories.get(client) !== owner ||
        ![...pending.subscribers].some((reader) => reader.canRead())
      ) {
        throw new DOMException("Cron inventory is no longer presented", "AbortError");
      }
    };
    void (async () => {
      try {
        for (;;) {
          if (owner.debounce) {
            await owner.debounce.promise;
          }
          assertPresented();
          const version = owner.version;
          const runtimeRevision = owner.runtimeRevision;
          let response = await client.request<CronJobsListResult<Row>>("cron.list", params, {
            signal: pending.controller.signal,
          });
          if (complete) {
            const first = readCanonicalCronListPage<Row>(response, params.limit ?? 50);
            resolveCronListPageNextOffset(first, 0);
            const jobs = [...first.jobs];
            let page = first;
            while (page.hasMore && version === owner.version) {
              const offset = resolveCronListPageNextOffset(page, page.offset);
              if (offset === null) {
                break;
              }
              assertPresented();
              const next = await client.request(
                "cron.list",
                { ...params, offset },
                { signal: pending.controller.signal },
              );
              if (version !== owner.version) {
                break;
              }
              page = readCanonicalCronListPage<Row>(next, params.limit ?? 50);
              resolveCronListPageNextOffset(page, offset);
              // Name order and membership hold until the advertised definition invalidation.
              if (first.total !== page.total) {
                throw new Error("Automation inventory changed. Refresh and try again.");
              }
              jobs.push(...page.jobs);
            }
            response = { ...first, jobs, limit: jobs.length, hasMore: false, nextOffset: null };
          }
          pending.controller.signal.throwIfAborted();
          if (inventories.get(client) !== owner) {
            throw new DOMException("Cron connection changed", "AbortError");
          }
          if (version !== owner.version) {
            continue;
          }
          let page =
            owner.supported && !complete
              ? readCanonicalCronListPage<Row>(response, params.limit ?? 50)
              : response;
          for (const runtime of owner.runtime.values()) {
            if (runtime.revision > runtimeRevision) {
              page = update(page, runtime, params);
            }
          }
          current.value = page;
          current.version = version;
          return page;
        }
      } catch (error) {
        current.version = -1;
        current.value = undefined;
        throw error;
      } finally {
        if (current.pending === pending) {
          current.pending = undefined;
        }
      }
    })().then(resolve, reject);
    return subscribeToSharedRequest(pending, subscriber, options.signal);
  }
}
