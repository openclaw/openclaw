import { channel } from "node:diagnostics_channel";
import os from "node:os";
import { getEnvironmentData, isMainThread, setEnvironmentData } from "node:worker_threads";
import type { WorkerPoolMemoryBudget } from "@openclaw/worker-runtime";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { GatewayResourceProfile } from "./gateway-resource-profile.js";
import {
  findCgroupV2MemoryLimitDirectory,
  readCgroupV2WorkingSetBytes,
  readProcessAvailableMemoryBytes,
} from "./host-memory.js";
import { resolveRuntimeProcessEntrypointUrl } from "./runtime-process-url.js";
import { forEachTrackedWorker, getWorkerPoolId } from "./worker-cpu.js";
import { workerScriptName } from "./worker-diagnostic-script.js";
import { resolveSqliteBrokerWorkerCount } from "./worker-pool-sizing.js";

/** Provisional: admission keeps this share of the hard limit free. */
export const WORKER_MEMORY_BUDGET_MARGIN = 0.15;

// Worker isolates inherit environment data, never child processes or the process environment.
const FLOOR_ONLY_KEY = "openclaw.workerMemoryBudget.floorOnly";
const MiB = 1024 ** 2;
// Reachable heap per worker after work (lean-ceiling attribution, rounded up). These are
// heap-graph proxies, not marginal RSS; the margin absorbs isolate overhead and later growth.
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
const poolFloor = (script: string, maxWorkers: number) =>
  Math.min(maxWorkers, script === "openclaw-state-read.worker.js" ? 2 : 1);

type HostedSlotPredicate = (url: string, key?: string) => boolean;

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
  growth: number;
  family: Family;
};

export type WorkerMemoryBudgetSnapshot = {
  limitBytes: number;
  budgetBytes: number;
  margin: number;
  usageBytes: number | null;
  usageSource: "cgroup-v2-working-set" | "host-used";
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
const state = resolveGlobalSingleton(
  Symbol.for("openclaw.workerMemoryBudget"),
  () => ({
    budget: undefined as ReturnType<typeof createWorkerMemoryBudget> | undefined,
    hosted: (() => false) as HostedSlotPredicate,
  }),
  (current) => {
    current.budget?.retire();
    current.budget = undefined;
    current.hosted = () => false;
    setEnvironmentData(FLOOR_ONLY_KEY, undefined);
  },
);

/** The lean shared host claims slots it serves; claimed slots need no isolate reservation. */
export function registerHostedSlotPredicate(predicate: HostedSlotPredicate): void {
  state.hosted = predicate;
}

/**
 * Direct workers whose owners keep a fixed number alive or restart them on demand. Their
 * floors are reserved once the family has been seen; other direct workers are measured only.
 */
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
      Number(hosted(sqliteStore, "agent")) -
      Number(hosted(sqliteStore, "shared-state")),
    "registry-worker.js": 1,
    "storage-worker.js": 1,
    "bridge.worker.js": 4,
    "shared-worker-host.worker.js": 1,
  };
}

/** Process-wide admission; pools keep their queues and dispatch. */
export function createWorkerMemoryBudget(params: {
  limitBytes: number;
  readUsageBytes: () => number | undefined;
  baselineBytes: number;
  usageSource: WorkerMemoryBudgetSnapshot["usageSource"];
  countLive: () => { pools: Map<number, number>; direct: Map<string, number> };
  poolId: (pool: object) => number;
  hosted: () => HostedSlotPredicate;
}) {
  const budgetBytes = Math.floor(params.limitBytes * (1 - WORKER_MEMORY_BUDGET_MARGIN));
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
    for (const entry of pools) {
      const pool = entry.pool.deref();
      if (!pool) {
        release(entry);
        continue;
      }
      // The shared host serves at most the first endpoint of a kind.
      const floor = entry.floor - Number(hosted(entry.url)) + Number(entry.pointReadFloor);
      const running = live.pools.get(params.poolId(pool)) ?? 0;
      floorBytes += floor * entry.estimate;
      pendingBytes += Math.max(0, floor + entry.growth - running) * entry.estimate;
    }
    for (const script of live.direct.keys()) {
      if (floors[script]) {
        seenDirect.add(script);
      }
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
      budgetBytes,
      margin: WORKER_MEMORY_BUDGET_MARGIN,
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
    registerPool(pool: object, url: URL, maxWorkers: number): WorkerPoolMemoryBudget {
      const script = workerScriptName(url);
      const floor = poolFloor(script, maxWorkers);
      const entry: PoolEntry = {
        pool: new WeakRef(pool),
        script,
        estimate: estimateBytes(script),
        url: url.href,
        floor,
        pointReadFloor: false,
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

/** Start admission once the Gateway has chosen lean; standard installs never create it. */
export function initializeWorkerMemoryBudget(profile: Readonly<GatewayResourceProfile>): void {
  state.budget?.retire();
  state.budget = undefined;
  // Workers created from here on inherit this Gateway's choice, never a previous one.
  setEnvironmentData(FLOOR_ONLY_KEY, profile.profile === "lean" ? true : undefined);
  if (profile.profile !== "lean") {
    return;
  }
  const directory =
    profile.memoryLimitSource === "cgroup-v2" ? findCgroupV2MemoryLimitDirectory() : undefined;
  const readUsageBytes = directory
    ? () => readCgroupV2WorkingSetBytes(directory)
    : () => os.totalmem() - readProcessAvailableMemoryBytes();
  state.budget = createWorkerMemoryBudget({
    limitBytes: profile.memoryLimitBytes,
    readUsageBytes,
    baselineBytes: readUsageBytes() ?? 0,
    usageSource: directory ? "cgroup-v2-working-set" : "host-used",
    countLive: () => {
      const pools = new Map<number, number>();
      const direct = new Map<string, number>();
      forEachTrackedWorker((script, poolId) => {
        if (poolId === undefined) {
          direct.set(script, (direct.get(script) ?? 0) + 1);
        } else {
          pools.set(poolId, (pools.get(poolId) ?? 0) + 1);
        }
      });
      return { pools, direct };
    },
    poolId: getWorkerPoolId,
    hosted: () => state.hosted,
  });
  log.info(
    `Lean worker memory budget: ${Math.round(state.budget.budgetBytes / MiB)} MiB of ${Math.round(profile.memoryLimitBytes / MiB)} MiB (${WORKER_MEMORY_BUDGET_MARGIN * 100}% margin); growth beyond each worker floor waits when it would exceed the budget.`,
  );
}

/** A closed pool's floor and growth no longer need room. */
export function releaseWorkerPoolMemoryBudget(pool: object): void {
  state.budget?.releasePool(pool);
}

export function getWorkerMemoryBudgetSnapshot(): WorkerMemoryBudgetSnapshot | undefined {
  return state.budget?.snapshot();
}

/** Environment data the native lifecycle supervisor forwards to the workers it creates. */
export function captureWorkerMemoryBudgetEnvironmentData() {
  return [FLOOR_ONLY_KEY, getEnvironmentData(FLOOR_ONLY_KEY)] as const;
}

/** Main-isolate pools join the ledger; pools nested in lean worker isolates never grow. */
export function createWorkerPoolMemoryBudget(
  pool: object,
  url: URL,
  maxWorkers: number,
): WorkerPoolMemoryBudget | undefined {
  if (isMainThread) {
    return state.budget?.registerPool(pool, url, maxWorkers);
  }
  if (getEnvironmentData(FLOOR_ONLY_KEY) !== true) {
    return undefined;
  }
  return {
    floor: poolFloor(workerScriptName(url), maxWorkers),
    isCurrent: () => true,
    admitGrowth: () => false,
    releaseGrowth() {},
    reservePointReadFloor() {},
    waitStarted() {},
    waitFinished() {},
  };
}
