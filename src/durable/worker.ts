import type { DurableRuntimeConfig } from "../config/types.durable.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  isDurableWorkerEnabled,
  resolveDurableWorkerClaimTtlMs,
  resolveDurableWorkerPollIntervalMs,
} from "./config.js";
import {
  reconcileExpiredDurableStepClaims,
  runDurableExecutorOnce,
  type DurableExecutorRunOnceOptions,
  type DurableExecutorRunOnceResult,
  type DurableExpiredStepClaimRecoveryResult,
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
  requeuedExpiredClaims: number;
  blockedExpiredClaims: number;
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
  recovery: DurableExpiredStepClaimRecoveryResult;
  claimedSteps: number;
  idle: boolean;
};

export type RunRegisteredDurableWorkersOnceOptions = {
  store: DurableRuntimeStore;
  registry: DurableRuntimeRegistry;
  workerId: string;
  claimTtlMs?: number;
  maxStepsPerOperation?: number;
  now?: () => number;
};

export type RunRegisteredDurableWorkersOnceResult = {
  claimsRecovered: number;
  claimsBlocked: number;
  stepsClaimed: number;
};

export type StartDurableRuntimeWorkerOptions = {
  store: DurableRuntimeStore;
  registry: DurableRuntimeRegistry;
  workerId: string;
  pollIntervalMs?: number;
  maxConcurrency?: number;
  claimTtlMs?: number;
  operationKind: string;
  operationVersion?: string;
  stepType?: DurableRuntimeStepType;
  now?: () => number;
};

export type StartDurableRuntimeWorkerFromConfigOptions = {
  registry: DurableRuntimeRegistry;
  workerId: string;
  env?: NodeJS.ProcessEnv;
  config?: DurableRuntimeConfig;
  operationKind: string;
  operationVersion?: string;
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

function requireRegisteredOperationScope(
  registry: DurableRuntimeRegistry,
  operationKind: string,
  operationVersion = "1",
): { operationKind: string; operationVersion: string } {
  const normalized = operationKind.trim();
  const normalizedVersion = operationVersion.trim();
  if (!normalized || !normalizedVersion) {
    throw new Error("Durable runtime worker requires an operationKind and operationVersion scope");
  }
  if (!registry.getRuntime(normalized, normalizedVersion)) {
    throw new Error(
      `Durable runtime worker operation is not registered: ${normalized}@${normalizedVersion}`,
    );
  }
  return { operationKind: normalized, operationVersion: normalizedVersion };
}

export async function runDurableWorkerBatch(
  options: DurableRuntimeWorkerBatchOptions,
): Promise<DurableRuntimeWorkerBatchResult> {
  const maxSteps = sanitizePositiveInteger(options.maxSteps, 1);
  const recovery = reconcileExpiredDurableStepClaims({
    store: options.store,
    registry: options.registry,
    operationKind: options.operationKind,
    operationVersion: options.operationVersion,
    now: options.now?.(),
  });
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
    recovery,
    claimedSteps,
    idle: claimedSteps === 0,
  };
}

export async function runRegisteredDurableWorkersOnce(
  options: RunRegisteredDurableWorkersOnceOptions,
): Promise<RunRegisteredDurableWorkersOnceResult> {
  const now = options.now ?? (() => Date.now());
  const claimTtlMs = sanitizePositiveInteger(options.claimTtlMs, 5 * 60 * 1000);
  const maxSteps = Math.min(32, sanitizePositiveInteger(options.maxStepsPerOperation, 32));
  let claimsRecovered = 0;
  let claimsBlocked = 0;
  let stepsClaimed = 0;

  for (const definition of options.registry.listRuntimes()) {
    if (options.registry.hasStepHandlers(definition.operationKind, definition.version)) {
      const batch = await runDurableWorkerBatch({
        store: options.store,
        registry: options.registry,
        workerId: `${options.workerId}:${definition.operationKind}@${definition.version}`,
        operationKind: definition.operationKind,
        operationVersion: definition.version,
        claimTtlMs,
        maxSteps,
        now,
      });
      claimsRecovered += batch.recovery.requeued;
      claimsBlocked += batch.recovery.requiresOwnerDecision + batch.recovery.unknownAfterSideEffect;
      stepsClaimed += batch.claimedSteps;
      continue;
    }

    const recovery = reconcileExpiredDurableStepClaims({
      store: options.store,
      registry: options.registry,
      operationKind: definition.operationKind,
      operationVersion: definition.version,
      now: now(),
    });
    claimsRecovered += recovery.requeued;
    claimsBlocked += recovery.requiresOwnerDecision + recovery.unknownAfterSideEffect;
  }

  return { claimsRecovered, claimsBlocked, stepsClaimed };
}

export function startDurableRuntimeWorker(
  options: StartDurableRuntimeWorkerOptions,
): DurableRuntimeWorkerHandle {
  const { operationKind, operationVersion } = requireRegisteredOperationScope(
    options.registry,
    options.operationKind,
    options.operationVersion,
  );
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
    requeuedExpiredClaims: 0,
    blockedExpiredClaims: 0,
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
      operationKind,
      operationVersion,
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
    try {
      const recovery = reconcileExpiredDurableStepClaims({
        store: options.store,
        registry: options.registry,
        operationKind,
        operationVersion,
        now: status.lastTickAt,
      });
      status.requeuedExpiredClaims += recovery.requeued;
      status.blockedExpiredClaims +=
        recovery.requiresOwnerDecision + recovery.unknownAfterSideEffect;
    } catch (err) {
      status.failedTicks += 1;
      status.lastError = String(err);
      ticking = false;
      log.warn(`durable runtime worker recovery failed: ${String(err)}`);
      return;
    }
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
    operationKind,
    operationVersion,
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

export function startDurableRuntimeWorkerFromConfig(
  options: StartDurableRuntimeWorkerFromConfigOptions,
): DurableRuntimeWorkerHandle {
  const env = options.env ?? process.env;
  if (!isDurableWorkerEnabled(options.config)) {
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
          requeuedExpiredClaims: 0,
          blockedExpiredClaims: 0,
          pollIntervalMs: resolveDurableWorkerPollIntervalMs(options.config),
          maxConcurrency: 1,
          claimTtlMs: resolveDurableWorkerClaimTtlMs(options.config),
        };
      },
      async stop(): Promise<void> {},
    };
  }

  const { operationKind, operationVersion } = requireRegisteredOperationScope(
    options.registry,
    options.operationKind,
    options.operationVersion,
  );
  const store = openDurableRuntimeStore({ env });
  let worker: DurableRuntimeWorkerHandle;
  try {
    worker = startDurableRuntimeWorker({
      store,
      registry: options.registry,
      workerId: options.workerId,
      pollIntervalMs: resolveDurableWorkerPollIntervalMs(options.config),
      maxConcurrency: 1,
      claimTtlMs: resolveDurableWorkerClaimTtlMs(options.config),
      operationKind,
      operationVersion,
      stepType: options.stepType,
    });
  } catch (error) {
    store.close();
    throw error;
  }

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
