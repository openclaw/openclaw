import { channel } from "node:diagnostics_channel";
import type { WorkerPoolMemoryBudget } from "@openclaw/worker-runtime";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveRuntimeProcessEntrypointUrl } from "./runtime-process-url.js";
import { sharedHostSqliteKeys } from "./shared-worker-host.types.js";
import { workerScriptName } from "./worker-diagnostic-script.js";
import { resolveSqliteBrokerWorkerCount } from "./worker-pool-sizing.js";
const MiB = 1024 ** 2;
// Reachable heap per worker after work (lean-ceiling attribution, rounded up). These are
// heap-graph proxies, not marginal RSS; the measured baseline and headroom absorb the rest.
const estimateMiB: Record<string, number> = {
  "gateway-state-owner-heartbeat.worker.js": 10,
  "openclaw-state-lease-heartbeat.worker.js": 19,
  "openclaw-state-read.worker.js": 37,
  "plugin-generation-preparation.worker.js": 20,
  "prepared-model-catalog.worker.js": 19,
  "provider-prompt-state.worker.js": 10,
  "registry-worker.js": 24,
  "session-accessor.sqlite-archive.worker.js": 49,
  "session-transcript.worker.js": 38,
  "shared-worker-host.worker.js": 90,
  "sqlite-store.worker.js": 61,
  "storage-worker.js": 28,
  "worker-native-lifecycle.worker.js": 10,
};
// Unmeasured kinds use the largest measured dedicated worker (61.01 MiB), rounded up.
const DEFAULT_ESTIMATE_MIB = 62;
const estimateBytes = (script: string) => (estimateMiB[script] ?? DEFAULT_ESTIMATE_MIB) * MiB;

// A retained settlement read must leave room for a fresh catalog read.
export const workerMemoryPoolFloor = (script: string, maxWorkers: number) =>
  Math.min(maxWorkers, script === "openclaw-state-read.worker.js" ? 2 : 1);

export type HostedSlotPredicate = (url: string, key?: string, pool?: object) => boolean;

type Family = {
  growth: number;
  growthAdmissions: number;
  refusals: number;
  waits: number;
  waitingTasks: number;
  waitMs: number;
  maxWaitMs: number;
};

type PoolEntry = {
  // An abandoned, unclosed pool releases its reservations once collected.
  pool: WeakRef<object>;
  script: string;
  estimate: number;
  url: string;
  floor: number;
  pointReadFloor: boolean;
  canHost: boolean;
  growth: number;
  family: Family;
};

export type WorkerMemoryBudgetSnapshot = {
  limitBytes: number;
  limitSource: "cgroup-v2" | "host";
  budgetBytes: number;
  basis: "cgroup-85" | "host-40" | "configured";
  usageBytes: number | null;
  usageSource: "cgroup-v2-working-set" | "process-rss";
  floorBytes: number;
  pendingBytes: number;
  /** Working set when admission started: the main isolate and any workers already running. */
  baselineBytes: number;
  /** Floors exceed the budget by estimate (baseline plus floor reservations) or by measurement. */
  floorsExceedBudget: boolean;
  growthAdmissions: number;
  refusals: number;
  waits: number;
  waitingTasks: number;
  waitMs: number;
  maxWaitMs: number;
  families: Array<{ family: string; growth: number } & Omit<Family, "growth">>;
};

const events = channel("openclaw.worker.budget");
const log = createSubsystemLogger("gateway/resources");
function directFloors(hosted: HostedSlotPredicate): Record<string, number> {
  const sqliteStore = resolveRuntimeProcessEntrypointUrl("sqliteStore").href;
  return {
    "worker-native-lifecycle.worker.js": 1,
    "gateway-state-owner-heartbeat.worker.js": 1,
    "openclaw-state-lease-heartbeat.worker.js": 1,
    // Agent carriers plus the shared-state carrier; hosted carriers run in the shared host.
    "sqlite-store.worker.js":
      resolveSqliteBrokerWorkerCount() +
      1 -
      Number(hosted(sqliteStore, sharedHostSqliteKeys.agent)) -
      Number(hosted(sqliteStore, sharedHostSqliteKeys["shared-state"])),
    "registry-worker.js": 1,
    "storage-worker.js": 1,
    "bridge.worker.js": 4,
    "shared-worker-host.worker.js": 1,
  };
}

/** Process-wide admission; pools keep their queues and dispatch. */
export function createWorkerMemoryBudget(params: {
  limitBytes: number;
  limitSource: WorkerMemoryBudgetSnapshot["limitSource"];
  budgetBytes: number;
  basis: WorkerMemoryBudgetSnapshot["basis"];
  readUsageBytes: () => number | undefined;
  baselineBytes: number;
  usageSource: WorkerMemoryBudgetSnapshot["usageSource"];
  countLive: () => { pools: Map<number, number>; direct: Map<string, number> };
  poolId: (pool: object) => number;
  hosted: () => HostedSlotPredicate;
  hasSharedHost?: () => boolean;
}) {
  const { budgetBytes } = params;
  const pools = new Set<PoolEntry>();
  const families = new Map<string, Family>();
  const seenDirect = new Set<string>();
  const release = (entry: PoolEntry) => {
    if (pools.delete(entry)) {
      entry.family.growth -= entry.growth;
      entry.growth = 0;
    }
  };
  let lastUsage: number | null = null;
  let warned = false;
  let floorUsageExceeded = false;
  // A retired owner's pools rebind to the current Gateway's policy on their next dispatch.
  let retired = false;
  const family = (name: string) => {
    let entry = families.get(name);
    if (!entry) {
      entry = {
        growth: 0,
        growthAdmissions: 0,
        refusals: 0,
        waits: 0,
        waitingTasks: 0,
        waitMs: 0,
        maxWaitMs: 0,
      };
      families.set(name, entry);
    }
    return entry;
  };
  /** Floors are reserved whether or not they run; only reservations not yet live are pending. */
  const ledger = () => {
    const live = params.countLive();
    const hosted = params.hosted();
    const floors = directFloors(hosted);
    // Per-kind estimates are heap proxies; the measured baseline charges the main isolate.
    let floorBytes = params.baselineBytes;
    let pendingBytes = 0;
    const claimed = new Set<string>();
    for (const entry of pools) {
      const pool = entry.pool.deref();
      if (!pool) {
        release(entry);
        continue;
      }
      // The shared host serves at most the first endpoint of a kind.
      const shared = entry.canHost && !claimed.has(entry.url) && hosted(entry.url, undefined, pool);
      if (shared) {
        claimed.add(entry.url);
      }
      const floor = entry.floor - Number(shared) + Number(entry.pointReadFloor);
      const running = live.pools.get(params.poolId(pool)) ?? 0;
      floorBytes += floor * entry.estimate;
      pendingBytes += Math.max(0, floor + entry.growth - running) * entry.estimate;
    }
    for (const script of live.direct.keys()) {
      if (floors[script]) {
        seenDirect.add(script);
      }
    }
    // Discounted pool and carrier floors transfer before the physical census receipt.
    const sharedCarriers =
      seenDirect.has("sqlite-store.worker.js") &&
      floors["sqlite-store.worker.js"]! < resolveSqliteBrokerWorkerCount() + 1;
    if (claimed.size > 0 || sharedCarriers || params.hasSharedHost?.()) {
      seenDirect.add("shared-worker-host.worker.js");
    }
    for (const script of seenDirect) {
      const floor = Math.max(0, floors[script] ?? 0);
      floorBytes += floor * estimateBytes(script);
      pendingBytes += Math.max(0, floor - (live.direct.get(script) ?? 0)) * estimateBytes(script);
    }
    if (!warned && floorBytes > budgetBytes) {
      warned = true;
      log.warn(
        `Lean worker floors alone (${Math.round(floorBytes / MiB)} MiB estimated, including the ${Math.round(params.baselineBytes / MiB)} MiB measured at startup) exceed the ${Math.round(budgetBytes / MiB)} MiB worker memory budget. Mandatory workers still start; no worker growth will be admitted. Raise the memory limit or reduce enabled features.`,
      );
    }
    return { floorBytes, pendingBytes };
  };
  const totals = () => {
    const sum = { growthAdmissions: 0, refusals: 0, waits: 0, waitingTasks: 0, waitMs: 0 };
    let maxWaitMs = 0;
    for (const entry of families.values()) {
      sum.growthAdmissions += entry.growthAdmissions;
      sum.refusals += entry.refusals;
      sum.waits += entry.waits;
      sum.waitingTasks += entry.waitingTasks;
      sum.waitMs += entry.waitMs;
      maxWaitMs = Math.max(maxWaitMs, entry.maxWaitMs);
    }
    return { ...sum, maxWaitMs };
  };
  const snapshot = (): WorkerMemoryBudgetSnapshot => {
    const { floorBytes, pendingBytes } = ledger();
    return {
      limitBytes: params.limitBytes,
      limitSource: params.limitSource,
      budgetBytes,
      basis: params.basis,
      usageBytes: lastUsage,
      usageSource: params.usageSource,
      floorBytes,
      pendingBytes,
      baselineBytes: params.baselineBytes,
      floorsExceedBudget: floorUsageExceeded || floorBytes > budgetBytes,
      ...totals(),
      families: Array.from(families, ([name, entry]) =>
        Object.assign({ family: name }, entry),
      ).toSorted((a, b) => a.family.localeCompare(b.family)),
    };
  };
  const publish = (event: string, name: string, extra?: object) => {
    if (events.hasSubscribers) {
      events.publish({ event, kind: name, ...extra, ...snapshot() });
    }
  };
  return {
    budgetBytes,
    snapshot,
    retire() {
      retired = true;
    },
    releasePool(pool: object) {
      for (const entry of pools) {
        if (entry.pool.deref() === pool) {
          release(entry);
        }
      }
    },
    registerPool(
      pool: object,
      url: URL,
      maxWorkers: number,
      canHost = true,
    ): WorkerPoolMemoryBudget {
      const script = workerScriptName(url);
      const floor = workerMemoryPoolFloor(script, maxWorkers);
      const entry: PoolEntry = {
        pool: new WeakRef(pool),
        script,
        estimate: estimateBytes(script),
        url: url.href,
        floor,
        pointReadFloor: false,
        canHost,
        growth: 0,
        family: family(script),
      };
      pools.add(entry);
      ledger();
      return {
        floor,
        isCurrent: () => !retired && pools.has(entry),
        admitGrowth() {
          const { floorBytes, pendingBytes } = ledger();
          lastUsage = params.readUsageBytes() ?? null;
          if (
            !floorUsageExceeded &&
            lastUsage !== null &&
            lastUsage >= budgetBytes &&
            [...families.values()].every((held) => held.growth === 0)
          ) {
            floorUsageExceeded = true;
            log.warn(
              `Lean Gateway memory use with only floor workers (${Math.round(lastUsage / MiB)} MiB measured) exceeds the ${Math.round(budgetBytes / MiB)} MiB worker memory budget. No worker growth will be admitted, and the Gateway may still reach its memory limit. Raise the memory limit or reduce enabled features.`,
            );
          }
          const projectedBytes = (lastUsage ?? 0) + pendingBytes + entry.estimate;
          if (lastUsage === null || floorBytes > budgetBytes || projectedBytes >= budgetBytes) {
            entry.family.refusals++;
            publish("refusal", script, { projectedBytes });
            return false;
          }
          entry.growth++;
          entry.family.growth++;
          entry.family.growthAdmissions++;
          publish("growth", script, { projectedBytes });
          return true;
        },
        releaseGrowth(count) {
          // A released pool's reservations were already removed.
          if (pools.has(entry)) {
            entry.growth -= count;
            entry.family.growth -= count;
          }
        },
        reservePointReadFloor() {
          entry.pointReadFloor = true;
        },
        waitStarted() {
          entry.family.waits++;
          entry.family.waitingTasks++;
          publish("wait", script);
        },
        waitFinished(elapsedMs) {
          entry.family.waitingTasks--;
          entry.family.waitMs += elapsedMs;
          entry.family.maxWaitMs = Math.max(entry.family.maxWaitMs, elapsedMs);
          publish("wait-finished", script, { elapsedMs });
        },
      };
    },
  };
}
