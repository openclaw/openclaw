import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  isDurableWorkerEnabled,
  resolveDurableWorkerClaimTtlMs,
  resolveDurableWorkerMaxConcurrency,
  resolveDurableWorkerPollIntervalMs,
} from "./config.js";
import {
  runDurableExecutorOnce,
  type DurableExecutorRunOnceOptions,
  type DurableExecutorRunOnceResult,
} from "./executor.js";
import type { DurableRuntimeRegistry } from "./registry.js";
import { openDurableRuntimeStore } from "./store-factory.js";
import type { DurableRuntimeStepType, DurableRuntimeStore } from "./types.js";

const log = createSubsystemLogger("durable/worker");

export type DurableRuntimeWorkerStatus = {
  workerId: string;
  running: boolean;
  stopped: boolean;
  startedAt: number;
  lastTickAt?: number;
  lastClaimAt?: number;
  lastIdleAt?: number;
  lastError?: string;
  inFlight: number;
  claimedSteps: number;
  idleTicks: number;
  failedTicks: number;
  pollIntervalMs: number;
  maxConcurrency: number;
  claimTtlMs: number;
};

export type DurableRuntimeWorkerHandle = {
  getStatus(): DurableRuntimeWorkerStatus;
  stop(): Promise<void>;
};

export type DurableRuntimeWorkerBatchOptions = Omit<DurableExecutorRunOnceOptions, "claimTtlMs"> & {
  claimTtlMs?: number;
  maxSteps?: number;
};

export type DurableRuntimeWorkerBatchResult = {
  results: DurableExecutorRunOnceResult[];
  claimedSteps: number;
  idle: boolean;
};

export type StartDurableRuntimeWorkerOptions = {
  store: DurableRuntimeStore;
  registry: DurableRuntimeRegistry;
  workerId: string;
  pollIntervalMs?: number;
  maxConcurrency?: number;
  claimTtlMs?: number;
  operationKind?: string;
  stepType?: DurableRuntimeStepType;
  now?: () => number;
};

export type StartDurableRuntimeWorkerFromEnvOptions = {
  registry: DurableRuntimeRegistry;
  workerId: string;
  env?: NodeJS.ProcessEnv;
  operationKind?: string;
  stepType?: DurableRuntimeStepType;
};

function sanitizePositiveInteger(value: number | undefined, fallback: number): number {
  const parsed = value ?? fallback;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.trunc(parsed);
}

function cloneStatus(status: DurableRuntimeWorkerStatus): DurableRuntimeWorkerStatus {
  return { ...status };
}

export async function runDurableWorkerBatch(
  options: DurableRuntimeWorkerBatchOptions,
): Promise<DurableRuntimeWorkerBatchResult> {
  const maxSteps = sanitizePositiveInteger(options.maxSteps, 1);
  const results: DurableExecutorRunOnceResult[] = [];
  let claimedSteps = 0;

  for (let index = 0; index < maxSteps; index += 1) {
    const result = await runDurableExecutorOnce({
      ...options,
      claimTtlMs: options.claimTtlMs,
    });
    results.push(result);
    if (!result.claimed) {
      break;
    }
    claimedSteps += 1;
  }

  return {
    results,
    claimedSteps,
    idle: claimedSteps === 0,
  };
}

export function startDurableRuntimeWorker(
  options: StartDurableRuntimeWorkerOptions,
): DurableRuntimeWorkerHandle {
  const now = options.now ?? (() => Date.now());
  const pollIntervalMs = sanitizePositiveInteger(options.pollIntervalMs, 1000);
  const maxConcurrency = Math.max(
    1,
    Math.min(32, sanitizePositiveInteger(options.maxConcurrency, 1)),
  );
  const claimTtlMs = sanitizePositiveInteger(options.claimTtlMs, 5 * 60 * 1000);
  const active = new Set<Promise<void>>();
  const status: DurableRuntimeWorkerStatus = {
    workerId: options.workerId,
    running: true,
    stopped: false,
    startedAt: now(),
    inFlight: 0,
    claimedSteps: 0,
    idleTicks: 0,
    failedTicks: 0,
    pollIntervalMs,
    maxConcurrency,
    claimTtlMs,
  };

  let stopped = false;
  let ticking = false;

  const launchOnce = () => {
    status.inFlight += 1;
    const task = runDurableExecutorOnce({
      store: options.store,
      registry: options.registry,
      workerId: options.workerId,
      operationKind: options.operationKind,
      stepType: options.stepType,
      claimTtlMs,
      now,
    })
      .then((result) => {
        if (result.claimed) {
          status.claimedSteps += 1;
          status.lastClaimAt = now();
          return;
        }
        status.idleTicks += 1;
        status.lastIdleAt = now();
      })
      .catch((err: unknown) => {
        status.failedTicks += 1;
        status.lastError = String(err);
        log.warn(`durable runtime worker tick failed: ${String(err)}`);
      })
      .finally(() => {
        status.inFlight = Math.max(0, status.inFlight - 1);
        active.delete(task);
      });
    active.add(task);
  };

  const tick = () => {
    if (stopped || ticking) {
      return;
    }
    ticking = true;
    status.lastTickAt = now();
    const available = Math.max(0, maxConcurrency - status.inFlight);
    for (let index = 0; index < available; index += 1) {
      launchOnce();
    }
    ticking = false;
  };

  const timer = setInterval(tick, pollIntervalMs);
  timer.unref?.();
  tick();

  log.info("started durable runtime worker", {
    workerId: options.workerId,
    pollIntervalMs,
    maxConcurrency,
    claimTtlMs,
    operationKind: options.operationKind,
    stepType: options.stepType,
  });

  return {
    getStatus(): DurableRuntimeWorkerStatus {
      return cloneStatus(status);
    },

    async stop(): Promise<void> {
      if (stopped) {
        return;
      }
      stopped = true;
      status.running = false;
      status.stopped = true;
      clearInterval(timer);
      await Promise.allSettled(active);
    },
  };
}

export function startDurableRuntimeWorkerFromEnv(
  options: StartDurableRuntimeWorkerFromEnvOptions,
): DurableRuntimeWorkerHandle {
  const env = options.env ?? process.env;
  if (!isDurableWorkerEnabled(env)) {
    return {
      getStatus(): DurableRuntimeWorkerStatus {
        return {
          workerId: options.workerId,
          running: false,
          stopped: true,
          startedAt: Date.now(),
          inFlight: 0,
          claimedSteps: 0,
          idleTicks: 0,
          failedTicks: 0,
          pollIntervalMs: resolveDurableWorkerPollIntervalMs(env),
          maxConcurrency: resolveDurableWorkerMaxConcurrency(env),
          claimTtlMs: resolveDurableWorkerClaimTtlMs(env),
        };
      },
      async stop(): Promise<void> {},
    };
  }

  const store = openDurableRuntimeStore({ env });
  const worker = startDurableRuntimeWorker({
    store,
    registry: options.registry,
    workerId: options.workerId,
    pollIntervalMs: resolveDurableWorkerPollIntervalMs(env),
    maxConcurrency: resolveDurableWorkerMaxConcurrency(env),
    claimTtlMs: resolveDurableWorkerClaimTtlMs(env),
    operationKind: options.operationKind,
    stepType: options.stepType,
  });

  return {
    getStatus(): DurableRuntimeWorkerStatus {
      return worker.getStatus();
    },

    async stop(): Promise<void> {
      await worker.stop();
      store.close();
    },
  };
}
