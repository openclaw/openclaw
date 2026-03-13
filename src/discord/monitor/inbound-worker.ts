import type { RuntimeEnv } from "./message-handler.preflight.types.js";
import type { DiscordMonitorStatusSink } from "./status.js";
import { createRunStateMachine } from "../../channels/run-state-machine.js";
import { danger } from "../../globals.js";
import { formatDurationSeconds } from "../../infra/format-time/format-duration.ts";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { materializeDiscordInboundJob, type DiscordInboundJob } from "./inbound-job.js";
import { processDiscordMessage } from "./message-handler.process.js";
import { normalizeDiscordInboundWorkerTimeoutMs, runDiscordTaskWithTimeout } from "./timeouts.js";

type DiscordInboundWorkerParams = {
  runtime: RuntimeEnv;
  setStatus?: DiscordMonitorStatusSink;
  abortSignal?: AbortSignal;
  runTimeoutMs?: number;
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

  return {
    enqueue(job) {
      void runQueue
        .enqueue(job.queueKey, async () => {
          if (!runState.isActive()) {
            return;
          }
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
          }
        })
        .catch((error) => {
          params.runtime.error?.(danger(`discord inbound worker failed: ${String(error)}`));
        });
    },
    deactivate: runState.deactivate,
  };
}
