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
import type { DurableWorkflowRegistry } from "./registry.js";
import { openDurableWorkflowStore } from "./store-factory.js";
import type { DurableWorkflowStepType, DurableWorkflowStore } from "./types.js";

const log = createSubsystemLogger("durable/worker");

export type DurableWorkflowWorkerStatus = {
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

export type DurableWorkflowWorkerHandle = {
  getStatus(): DurableWorkflowWorkerStatus;
  stop(): Promise<void>;
};

export type DurableWorkflowWorkerBatchOptions = Omit<
  DurableExecutorRunOnceOptions,
  "claimTtlMs"
> & {
  claimTtlMs?: number;
  maxSteps?: number;
};

export type DurableWorkflowWorkerBatchResult = {
  results: DurableExecutorRunOnceResult[];
  claimedSteps: number;
  idle: boolean;
};

export type StartDurableWorkflowWorkerOptions = {
  store: DurableWorkflowStore;
  registry: DurableWorkflowRegistry;
  workerId: string;
  pollIntervalMs?: number;
  maxConcurrency?: number;
  claimTtlMs?: number;
  workflowId?: string;
  stepType?: DurableWorkflowStepType;
  now?: () => number;
};

export type StartDurableWorkflowWorkerFromEnvOptions = {
  registry: DurableWorkflowRegistry;
  workerId: string;
  env?: NodeJS.ProcessEnv;
  workflowId?: string;
  stepType?: DurableWorkflowStepType;
};

function sanitizePositiveInteger(value: number | undefined, fallback: number): number {
  const parsed = value ?? fallback;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.trunc(parsed);
}

function cloneStatus(status: DurableWorkflowWorkerStatus): DurableWorkflowWorkerStatus {
  return { ...status };
}

export async function runDurableWorkerBatch(
  options: DurableWorkflowWorkerBatchOptions,
): Promise<DurableWorkflowWorkerBatchResult> {
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

export function startDurableWorkflowWorker(
  options: StartDurableWorkflowWorkerOptions,
): DurableWorkflowWorkerHandle {
  const now = options.now ?? (() => Date.now());
  const pollIntervalMs = sanitizePositiveInteger(options.pollIntervalMs, 1000);
  const maxConcurrency = Math.max(
    1,
    Math.min(32, sanitizePositiveInteger(options.maxConcurrency, 1)),
  );
  const claimTtlMs = sanitizePositiveInteger(options.claimTtlMs, 5 * 60 * 1000);
  const active = new Set<Promise<void>>();
  const status: DurableWorkflowWorkerStatus = {
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
      workflowId: options.workflowId,
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
        log.warn(`durable workflow worker tick failed: ${String(err)}`);
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

  log.info("started durable workflow worker", {
    workerId: options.workerId,
    pollIntervalMs,
    maxConcurrency,
    claimTtlMs,
    workflowId: options.workflowId,
    stepType: options.stepType,
  });

  return {
    getStatus(): DurableWorkflowWorkerStatus {
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

export function startDurableWorkflowWorkerFromEnv(
  options: StartDurableWorkflowWorkerFromEnvOptions,
): DurableWorkflowWorkerHandle {
  const env = options.env ?? process.env;
  if (!isDurableWorkerEnabled(env)) {
    return {
      getStatus(): DurableWorkflowWorkerStatus {
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

  const store = openDurableWorkflowStore({ env });
  const worker = startDurableWorkflowWorker({
    store,
    registry: options.registry,
    workerId: options.workerId,
    pollIntervalMs: resolveDurableWorkerPollIntervalMs(env),
    maxConcurrency: resolveDurableWorkerMaxConcurrency(env),
    claimTtlMs: resolveDurableWorkerClaimTtlMs(env),
    workflowId: options.workflowId,
    stepType: options.stepType,
  });

  return {
    getStatus(): DurableWorkflowWorkerStatus {
      return worker.getStatus();
    },

    async stop(): Promise<void> {
      await worker.stop();
      store.close();
    },
  };
}
