import { createActiveDispatchTracker } from "../../channels/active-dispatches.js";
import { createRunStateMachine } from "../../channels/run-state-machine.js";
import { danger } from "../../globals.js";
import { formatDurationSeconds } from "../../infra/format-time/format-duration.ts";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { materializeDiscordInboundJob, type DiscordInboundJob } from "./inbound-job.js";
import type { RuntimeEnv } from "./message-handler.preflight.types.js";
import { processDiscordMessage } from "./message-handler.process.js";
import type { DiscordMonitorStatusSink } from "./status.js";
import { normalizeDiscordInboundWorkerTimeoutMs, runDiscordTaskWithTimeout } from "./timeouts.js";

type DiscordInboundWorkerParams = {
  runtime: RuntimeEnv;
  setStatus?: DiscordMonitorStatusSink;
  abortSignal?: AbortSignal;
  runTimeoutMs?: number;
  steerMode?: boolean;
};

export type DiscordInboundWorker = {
  enqueue: (job: DiscordInboundJob) => void;
  deactivate: () => void;
};

function formatDiscordRunContextSuffix(job: DiscordInboundJob): string {
  const channelId = job.payload.messageChannelId?.trim();
  const messageId = job.payload.data?.message?.id?.trim();
  const details = [
    channelId ? `channelId=${channelId}` : null,
    messageId ? `messageId=${messageId}` : null,
  ].filter((entry): entry is string => Boolean(entry));
  if (details.length === 0) {
    return "";
  }
  return ` (${details.join(", ")})`;
}

async function processDiscordInboundJob(params: {
  job: DiscordInboundJob;
  runtime: RuntimeEnv;
  lifecycleSignal?: AbortSignal;
  runTimeoutMs?: number;
}) {
  const timeoutMs = normalizeDiscordInboundWorkerTimeoutMs(params.runTimeoutMs);
  const contextSuffix = formatDiscordRunContextSuffix(params.job);
  await runDiscordTaskWithTimeout({
    run: async (abortSignal) => {
      await processDiscordMessage(materializeDiscordInboundJob(params.job, abortSignal));
    },
    timeoutMs,
    abortSignals: [params.job.runtime.abortSignal, params.lifecycleSignal],
    onTimeout: (resolvedTimeoutMs) => {
      params.runtime.error?.(
        danger(
          `discord inbound worker timed out after ${formatDurationSeconds(resolvedTimeoutMs, {
            decimals: 1,
            unit: "seconds",
          })}${contextSuffix}`,
        ),
      );
    },
    onErrorAfterTimeout: (error) => {
      params.runtime.error?.(
        danger(`discord inbound worker failed after timeout: ${String(error)}${contextSuffix}`),
      );
    },
  });
}

export function createDiscordInboundWorker(
  params: DiscordInboundWorkerParams,
): DiscordInboundWorker {
  const runQueue = new KeyedAsyncQueue();
  const runState = createRunStateMachine({
    setStatus: params.setStatus,
    abortSignal: params.abortSignal,
  });
  const dispatches = params.steerMode ? createActiveDispatchTracker() : undefined;

  return {
    enqueue(job) {
      // When steer mode is active and another dispatch is already running for
      // the same queue key, use a unique key so this job runs concurrently.
      // This lets the steer check in get-reply-run.ts see the active run and
      // inject the follow-up message via agent.steer().
      const effectiveKey =
        dispatches && dispatches.isActive(job.queueKey)
          ? `${job.queueKey}:steer:${Date.now()}`
          : job.queueKey;

      void runQueue
        .enqueue(effectiveKey, async () => {
          if (!runState.isActive()) {
            return;
          }
          dispatches?.mark(job.queueKey);
          runState.onRunStart();
          try {
            if (!runState.isActive()) {
              return;
            }
            await processDiscordInboundJob({
              job,
              runtime: params.runtime,
              lifecycleSignal: params.abortSignal,
              runTimeoutMs: params.runTimeoutMs,
            });
          } finally {
            runState.onRunEnd();
            dispatches?.clear(job.queueKey);
          }
        })
        .catch((error) => {
          params.runtime.error?.(danger(`discord inbound worker failed: ${String(error)}`));
        });
    },
    deactivate: runState.deactivate,
  };
}
