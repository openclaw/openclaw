import { getEnvironmentData, isMainThread, setEnvironmentData } from "node:worker_threads";
import type { WorkerPoolMemoryBudget } from "@openclaw/worker-runtime";
import type { GatewayConfig } from "../config/types.gateway.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { GatewayResourceProfile } from "./gateway-resource-profile.js";
import { findCgroupV2MemoryLimitDirectory, readCgroupV2WorkingSetBytes } from "./host-memory.js";
import { forEachTrackedWorker, getWorkerPoolId } from "./worker-cpu.js";
import { workerScriptName } from "./worker-diagnostic-script.js";
import {
  createWorkerMemoryBudget,
  workerMemoryPoolFloor,
  type HostedSlotPredicate,
  type WorkerMemoryBudgetSnapshot,
} from "./worker-memory-budget-ledger.js";

// Provisional shares. A container limit was sized for OpenClaw; host RAM is shared with
// everything else on the machine.
const CGROUP_BUDGET_SHARE = 0.85;
const HOST_BUDGET_SHARE = 0.4;

// Worker isolates inherit environment data, never child processes or the process environment.
const FLOOR_ONLY_KEY = "openclaw.workerMemoryBudget.floorOnly";
const MiB = 1024 ** 2;
const log = createSubsystemLogger("gateway/resources");
const state = resolveGlobalSingleton<{
  budget?: ReturnType<typeof createWorkerMemoryBudget>;
  hosted: HostedSlotPredicate;
  hasSharedHost: () => boolean;
  floorOnlyPublished?: true;
}>(
  Symbol.for("openclaw.workerMemoryBudget"),
  () => ({ hosted: () => false, hasSharedHost: () => false }),
  (current) => {
    current.budget?.retire();
    current.budget = undefined;
    publishFloorOnly(current, false);
  },
);

// Only a lean Gateway publishes the flag, so other processes never touch environment data.
function publishFloorOnly(current: { floorOnlyPublished?: true }, floorOnly: boolean): void {
  if (floorOnly) {
    setEnvironmentData(FLOOR_ONLY_KEY, true);
    current.floorOnlyPublished = true;
  } else if (current.floorOnlyPublished) {
    setEnvironmentData(FLOOR_ONLY_KEY, undefined);
    current.floorOnlyPublished = undefined;
  }
}

export function registerHostedMemoryPredicates(
  hosted: HostedSlotPredicate,
  hasSharedHost: () => boolean,
): void {
  state.hosted = hosted;
  state.hasSharedHost = hasSharedHost;
}

/** Start admission once the Gateway has chosen lean; standard installs never create it. */
export function initializeWorkerMemoryBudget(
  profile: Readonly<GatewayResourceProfile>,
  resources: GatewayConfig["resources"],
): void {
  state.budget?.retire();
  state.budget = undefined;
  // Workers created from here on inherit this Gateway's choice, never a previous one.
  publishFloorOnly(state, profile.profile === "lean");
  if (profile.profile !== "lean") {
    return;
  }
  const directory =
    profile.memoryLimitSource === "cgroup-v2" ? findCgroupV2MemoryLimitDirectory() : undefined;
  // Without a container, measure the Gateway process itself, not other programs on the host.
  const readUsageBytes = directory
    ? () => readCgroupV2WorkingSetBytes(directory)
    : () => process.memoryUsage.rss();
  const configured = resources?.memoryBudgetMiB;
  const basis = configured
    ? "configured"
    : profile.memoryLimitSource === "cgroup-v2"
      ? "cgroup-85"
      : "host-40";
  state.budget = createWorkerMemoryBudget({
    limitBytes: profile.memoryLimitBytes,
    limitSource: profile.memoryLimitSource,
    budgetBytes: configured
      ? configured * MiB
      : Math.floor(
          profile.memoryLimitBytes *
            (basis === "cgroup-85" ? CGROUP_BUDGET_SHARE : HOST_BUDGET_SHARE),
        ),
    basis,
    readUsageBytes,
    baselineBytes: readUsageBytes() ?? 0,
    usageSource: directory ? "cgroup-v2-working-set" : "process-rss",
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
    hasSharedHost: () => state.hasSharedHost(),
  });
  log.info(
    `Lean worker memory budget: ${Math.round(state.budget.budgetBytes / MiB)} MiB (${basis}) of ${Math.round(profile.memoryLimitBytes / MiB)} MiB ${profile.memoryLimitSource}; growth beyond each worker floor waits when it would exceed the budget.`,
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
  canHost = true,
): WorkerPoolMemoryBudget | undefined {
  if (isMainThread) {
    return state.budget?.registerPool(pool, url, maxWorkers, canHost);
  }
  if (getEnvironmentData(FLOOR_ONLY_KEY) !== true) {
    return undefined;
  }
  return {
    floor: workerMemoryPoolFloor(workerScriptName(url), maxWorkers),
    isCurrent: () => true,
    admitGrowth: () => false,
    releaseGrowth() {},
    reservePointReadFloor() {},
    waitStarted() {},
    waitFinished() {},
  };
}
