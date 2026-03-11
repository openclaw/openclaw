import { randomUUID } from "node:crypto";
import type { CliDeps } from "../../cli/deps.js";
import { loadConfig } from "../../config/config.js";
import { resolveMainSessionKeyFromConfig } from "../../config/sessions.js";
import {
  runCronIsolatedAgentTurn,
  type RunCronAgentTurnResult,
} from "../../cron/isolated-agent.js";
import type { CronJob } from "../../cron/types.js";
import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeHookDispatchSessionKey, type HookAgentDispatchPayload } from "../hooks.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

export type DetachedAgentDispatchObserver = {
  onStarted?: (params: {
    runId: string;
    startedAt: number;
    agentId?: string;
  }) => void | Promise<void>;
  onFinished?: (params: {
    runId: string;
    finishedAt: number;
    agentId?: string;
    result: RunCronAgentTurnResult;
  }) => void | Promise<void>;
  onError?: (params: {
    runId: string;
    finishedAt: number;
    agentId?: string;
    error: unknown;
  }) => void | Promise<void>;
};

async function runObserver(
  callback: (() => void | Promise<void>) | undefined,
  log: SubsystemLogger,
  label: string,
): Promise<void> {
  if (!callback) {
    return;
  }
  try {
    await callback();
  } catch (error) {
    log.warn(`${label}: ${String(error)}`);
  }
}

export function dispatchDetachedAgentTurn(params: {
  deps: CliDeps;
  log: SubsystemLogger;
  value: HookAgentDispatchPayload;
  observer?: DetachedAgentDispatchObserver;
  onUndeliveredSummary?: (params: {
    result: RunCronAgentTurnResult;
    jobId: string;
    name: string;
    wakeMode: "now" | "next-heartbeat";
    mainSessionKey: string;
  }) => void | Promise<void>;
  onErrorFallback?: (params: {
    error: unknown;
    jobId: string;
    name: string;
    wakeMode: "now" | "next-heartbeat";
    mainSessionKey: string;
  }) => void | Promise<void>;
}): string {
  const sessionKey = normalizeHookDispatchSessionKey({
    sessionKey: params.value.sessionKey,
    targetAgentId: params.value.agentId,
  });
  const mainSessionKey = resolveMainSessionKeyFromConfig();
  const jobId = randomUUID();
  const now = Date.now();
  const job: CronJob = {
    id: jobId,
    agentId: params.value.agentId,
    name: params.value.name,
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "at", at: new Date(now).toISOString() },
    sessionTarget: "isolated",
    wakeMode: params.value.wakeMode,
    payload: {
      kind: "agentTurn",
      message: params.value.message,
      model: params.value.model,
      thinking: params.value.thinking,
      timeoutSeconds: params.value.timeoutSeconds,
      deliver: params.value.deliver,
      channel: params.value.channel,
      to: params.value.to,
      allowUnsafeExternalContent: params.value.allowUnsafeExternalContent,
    },
    state: { nextRunAtMs: now },
  };

  const runId = randomUUID();
  void (async () => {
    try {
      await runObserver(
        () =>
          params.observer?.onStarted?.({
            runId,
            startedAt: Date.now(),
            agentId: params.value.agentId,
          }),
        params.log,
        "detached agent start observer failed",
      );

      const cfg = loadConfig();
      const result = await runCronIsolatedAgentTurn({
        cfg,
        deps: params.deps,
        job,
        message: params.value.message,
        sessionKey,
        lane: "cron",
        deliveryContract: "shared",
      });

      await runObserver(
        () =>
          params.observer?.onFinished?.({
            runId,
            finishedAt: Date.now(),
            agentId: params.value.agentId,
            result,
          }),
        params.log,
        "detached agent finish observer failed",
      );

      if (!result.delivered) {
        await runObserver(
          () =>
            params.onUndeliveredSummary?.({
              result,
              jobId,
              name: params.value.name,
              wakeMode: params.value.wakeMode,
              mainSessionKey,
            }),
          params.log,
          "detached agent undelivered observer failed",
        );
      }
    } catch (error) {
      await runObserver(
        () =>
          params.observer?.onError?.({
            runId,
            finishedAt: Date.now(),
            agentId: params.value.agentId,
            error,
          }),
        params.log,
        "detached agent error observer failed",
      );

      await runObserver(
        () =>
          params.onErrorFallback?.({
            error,
            jobId,
            name: params.value.name,
            wakeMode: params.value.wakeMode,
            mainSessionKey,
          }),
        params.log,
        "detached agent error fallback failed",
      );
    }
  })();

  return runId;
}

export function handleDefaultUndeliveredSummary(params: {
  result: RunCronAgentTurnResult;
  jobId: string;
  name: string;
  wakeMode: "now" | "next-heartbeat";
  mainSessionKey: string;
}): void {
  const summary =
    params.result.summary?.trim() || params.result.error?.trim() || params.result.status;
  const prefix =
    params.result.status === "ok"
      ? `Hook ${params.name}`
      : `Hook ${params.name} (${params.result.status})`;
  enqueueSystemEvent(`${prefix}: ${summary}`.trim(), {
    sessionKey: params.mainSessionKey,
  });
  if (params.wakeMode === "now") {
    requestHeartbeatNow({ reason: `hook:${params.jobId}` });
  }
}

export function handleDefaultDispatchError(params: {
  error: unknown;
  jobId: string;
  name: string;
  wakeMode: "now" | "next-heartbeat";
  mainSessionKey: string;
  log: SubsystemLogger;
}): void {
  params.log.warn(`hook agent failed: ${String(params.error)}`);
  enqueueSystemEvent(`Hook ${params.name} (error): ${String(params.error)}`, {
    sessionKey: params.mainSessionKey,
  });
  if (params.wakeMode === "now") {
    requestHeartbeatNow({ reason: `hook:${params.jobId}:error` });
  }
}
