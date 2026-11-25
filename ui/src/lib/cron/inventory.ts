import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { CronListParams } from "../../../../packages/gateway-protocol/src/schema/cron.types.ts";
import { sortCronJobs } from "../../../../src/cron/service/list-page-sort.ts";
import {
  readCanonicalCronListPage,
  resolveCronListPageNextOffset,
} from "../../../../src/cron/service/list-page-validation.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CronCompactJob, CronJobsListResult } from "../../api/types.ts";
import { subscribeToSharedRequest } from "../shared-request-subscription.ts";
import {
  getCronInventory,
  isCurrentCronInventory,
  type Entry,
  type Inventory,
  type Runtime,
} from "./inventory-connection.ts";
import { applyFullCronRuntime, applyCompactCronRuntime } from "./runtime-projection.ts";

function updateFull(page: CronJobsListResult, event: Runtime) {
  const index = page.jobs.findIndex((job) => job.id === event.jobId);
  const previous = page.jobs[index];
  if (!previous || previous.updatedAtMs > event.job.updatedAtMs) {
    return page;
  }
  return {
    ...page,
    snapshotRevision: `runtime:${event.revision}`,
    jobs: page.jobs.with(index, applyFullCronRuntime(previous, event)),
  };
}

function updateCompact(page: CronJobsListResult<CronCompactJob>, event: Runtime) {
  const index = page.jobs.findIndex((job) => job.id === event.jobId);
  const previous = page.jobs[index];
  if (!previous || previous.updatedAtMs > event.job.updatedAtMs) {
    return page;
  }
  return {
    ...page,
    snapshotRevision: `runtime:${event.revision}`,
    jobs: page.jobs.with(index, applyCompactCronRuntime(previous, event)),
  };
}

type ReadOptions = {
  refresh?: boolean;
  signal?: AbortSignal;
  canRead?: () => boolean;
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
  const owner = getCronInventory(client);
  const source = inventoryQuery(params);
  return params.compact
    ? readRows(client, owner, owner.compact, source, updateCompact, options).then((page) =>
        selectPage(
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
        ),
      )
    : readRows(client, owner, owner.full, source, updateFull, options).then((page) =>
        selectPage(
          page,
          params,
          (job) => job.state.lastRunStatus ?? job.state.lastStatus,
          (jobs) => sortCronJobs(jobs, params.sortBy ?? "nextRunAtMs", params.sortDir ?? "asc"),
        ),
      );
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
  update: (page: CronJobsListResult<Row>, event: Runtime) => CronJobsListResult<Row>,
  options: ReadOptions,
): Promise<CronJobsListResult<Row>> {
  const key = queryKey(params);
  let entry = entries.get(key);
  if (!entry) {
    entry = {
      version: -1,
      applyRuntime(runtime) {
        if (this.value) {
          this.value = update(this.value, runtime);
        }
      },
    };
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
  if (current.pending && !current.pending.controller.signal.aborted) {
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
        !isCurrentCronInventory(client, owner) ||
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
          const response = await client.request<CronJobsListResult<Row>>("cron.list", params, {
            signal: pending.controller.signal,
          });
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
            // Name order and membership hold until the definition invalidation.
            if (first.total !== page.total) {
              throw new Error("Automation inventory changed. Refresh and try again.");
            }
            jobs.push(...page.jobs);
          }
          pending.controller.signal.throwIfAborted();
          if (!isCurrentCronInventory(client, owner)) {
            throw new DOMException("Cron connection changed", "AbortError");
          }
          if (version !== owner.version) {
            continue;
          }
          let result: CronJobsListResult<Row> = {
            ...first,
            jobs,
            limit: jobs.length,
            hasMore: false,
            nextOffset: null,
          };
          for (const runtime of owner.runtime.values()) {
            if (runtime.revision > runtimeRevision) {
              result = update(result, runtime);
            }
          }
          current.value = result;
          current.version = version;
          return result;
        }
      } catch (error) {
        if (current.pending === pending) {
          current.version = -1;
          current.value = undefined;
        }
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

function queryKey(params: CronListParams) {
  return JSON.stringify(
    Object.keys(params)
      .toSorted()
      .filter((key) => Reflect.get(params, key) !== undefined)
      .map((key) => [key, Reflect.get(params, key)]),
  );
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
  const owner = getCronInventory(client);
  const source = inventoryQuery(params);
  const key = queryKey(source);
  const page = params.compact ? owner?.compact.get(key)?.value : owner?.full.get(key)?.value;
  return page?.jobs.some((job) => job.id === payload.jobId) === true;
}
