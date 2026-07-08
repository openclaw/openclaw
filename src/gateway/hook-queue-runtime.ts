// Process-local drain loop for durable Gateway webhook queues.
import { randomUUID } from "node:crypto";
import type { CliDeps } from "../cli/deps.types.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { runHookAgentDispatch } from "./hook-agent-runner.js";
import {
  claimNextHookQueueItem,
  enqueueHookQueueItem,
  failHookQueueItem,
  finishHookQueueItem,
  requeueRunningHookQueueItems,
  setHookQueuePaused,
  type HookQueueItem,
  type QueuedHookAgentPayload,
} from "./hook-queue-store.js";
import type { HookQueueResolved, HooksConfigResolved } from "./hooks.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

export type HookQueueEnqueueResult = {
  itemId: string;
  runId: string;
};

export type HookQueueRuntime = {
  enqueueAgentHook: (input: {
    queueId: string;
    sourcePath: string;
    payload: QueuedHookAgentPayload;
  }) => HookQueueEnqueueResult;
  scheduleDrain: (queueId: string) => void;
  scheduleDrainAll: () => void;
  setQueuePaused: (
    queueId: string,
    paused: boolean,
  ) => {
    queueId: string;
    paused: boolean;
    pausedAtMs: number | null;
    updatedAtMs: number;
  };
};

function resolveQueue(
  config: HooksConfigResolved | null,
  queueId: string,
): HookQueueResolved | null {
  return config?.queues.find((queue) => queue.id === queueId) ?? null;
}

export function createHookQueueRuntime(params: {
  deps: CliDeps;
  getHooksConfig: () => HooksConfigResolved | null;
  logHooks: SubsystemLogger;
}): HookQueueRuntime {
  const activeByQueue = new Map<string, number>();
  const scheduledQueues = new Set<string>();

  const setActive = (queueId: string, delta: number) => {
    const next = Math.max(0, (activeByQueue.get(queueId) ?? 0) + delta);
    if (next === 0) {
      activeByQueue.delete(queueId);
    } else {
      activeByQueue.set(queueId, next);
    }
  };

  const runItem = async (item: HookQueueItem) => {
    try {
      const completion = await runHookAgentDispatch({
        deps: params.deps,
        logHooks: params.logHooks,
        identity: { jobId: item.jobId, runId: item.runId },
        value: item.payload,
        sessionTarget: item.sessionTarget,
      });
      finishHookQueueItem({
        itemId: item.itemId,
        status: completion.status === "ok" ? "ok" : "error",
        summary: completion.summary,
        error: completion.error,
      });
    } catch (err) {
      failHookQueueItem({
        itemId: item.itemId,
        error: String(err),
      });
    } finally {
      setActive(item.queueId, -1);
      runtime.scheduleDrain(item.queueId);
    }
  };

  const drainQueue = (queueId: string) => {
    scheduledQueues.delete(queueId);
    const queue = resolveQueue(params.getHooksConfig(), queueId);
    if (!queue) {
      return;
    }
    while ((activeByQueue.get(queueId) ?? 0) < queue.parallelism) {
      let item: HookQueueItem | null = null;
      try {
        item = claimNextHookQueueItem({ queueId });
      } catch (err) {
        params.logHooks.warn(`hook queue claim failed for ${queueId}: ${String(err)}`);
        return;
      }
      if (!item) {
        return;
      }
      setActive(queueId, 1);
      void runItem(item);
    }
  };

  const runtime: HookQueueRuntime = {
    enqueueAgentHook: (input) => {
      const itemId = randomUUID();
      const runId = randomUUID();
      const jobId = randomUUID();
      enqueueHookQueueItem({
        itemId,
        runId,
        jobId,
        queueId: input.queueId,
        sourcePath: input.sourcePath,
        payload: input.payload,
      });
      runtime.scheduleDrain(input.queueId);
      return { itemId, runId };
    },
    scheduleDrain: (queueId) => {
      if (scheduledQueues.has(queueId)) {
        return;
      }
      scheduledQueues.add(queueId);
      queueMicrotask(() => drainQueue(queueId));
    },
    scheduleDrainAll: () => {
      const queueIds = params.getHooksConfig()?.queues.map((queue) => queue.id) ?? [];
      for (const queueId of queueIds) {
        runtime.scheduleDrain(queueId);
      }
    },
    setQueuePaused: (queueId, paused) => {
      const result = setHookQueuePaused({ queueId, paused });
      if (!paused) {
        runtime.scheduleDrain(queueId);
      }
      return result;
    },
  };

  const configuredQueueIds = params.getHooksConfig()?.queues.map((queue) => queue.id) ?? [];
  if (configuredQueueIds.length > 0) {
    requeueRunningHookQueueItems({ queueIds: configuredQueueIds });
    runtime.scheduleDrainAll();
  }

  return runtime;
}
