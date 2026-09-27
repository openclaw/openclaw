import { resolveAgentConfig } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { HOST_PROGRESS_SUPERVISOR_KIND, type ReplyPayload } from "../reply-payload.js";

const DEFAULT_PROGRESS_SUPERVISOR_INTERVAL_MS = 55_000;
const DEFAULT_PROGRESS_SUPERVISOR_TEXT =
  "Work is still in progress. Another update will follow if needed.";
const PROGRESS_SUPERVISOR_GENERATION_KEY = "openclawProgressGeneration";

export function resolveProgressSupervisorConfig(params: { cfg: OpenClawConfig; agentId: string }): {
  enabled: boolean;
  intervalMs: number;
  text: string;
} {
  const configured =
    resolveAgentConfig(params.cfg, params.agentId)?.progressSupervisor ??
    params.cfg.agents?.defaults?.progressSupervisor;
  return {
    enabled: configured?.enabled === true,
    intervalMs:
      (configured?.intervalSeconds ?? DEFAULT_PROGRESS_SUPERVISOR_INTERVAL_MS / 1000) * 1000,
    text: configured?.text ?? DEFAULT_PROGRESS_SUPERVISOR_TEXT,
  };
}

function readProgressSupervisorGeneration(payload: ReplyPayload): number | undefined {
  const generation = payload.channelData?.[PROGRESS_SUPERVISOR_GENERATION_KEY];
  return typeof generation === "number" ? generation : undefined;
}

function buildProgressSupervisorPayload(params: {
  generation: number;
  text: string;
}): ReplyPayload {
  return {
    text: params.text,
    isStatusNotice: true,
    channelData: {
      openclawProgressKind: HOST_PROGRESS_SUPERVISOR_KIND,
      [PROGRESS_SUPERVISOR_GENERATION_KEY]: params.generation,
    },
  };
}

/** Host-owned quiet-period timer. Stop joins an in-flight emission before finalization continues. */
export function createProgressSupervisor(params: {
  enabled: boolean;
  intervalMs?: number;
  text?: string;
  abortSignal?: AbortSignal;
  emit: (payload: ReplyPayload) => Promise<void> | void;
}) {
  const intervalMs = params.intervalMs ?? DEFAULT_PROGRESS_SUPERVISOR_INTERVAL_MS;
  const text = params.text ?? DEFAULT_PROGRESS_SUPERVISOR_TEXT;
  let active = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let emission: Promise<void> | undefined;

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const isCurrentPayload = (payload: ReplyPayload) =>
    active && readProgressSupervisorGeneration(payload) === generation;
  const schedule = () => {
    if (!active || emission || timer !== undefined) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      if (!active || emission) {
        return;
      }
      const payload = buildProgressSupervisorPayload({ generation, text });
      const pending = Promise.resolve(params.emit(payload))
        .catch(() => undefined)
        .finally(() => {
          if (emission === pending) {
            emission = undefined;
          }
        });
      emission = pending;
    }, intervalMs);
    timer.unref?.();
  };
  const stop = async () => {
    if (active) {
      active = false;
      generation += 1;
      clearTimer();
      params.abortSignal?.removeEventListener("abort", onAbort);
    }
    await emission;
  };
  const onAbort = () => {
    void stop();
  };
  const noteVisibleReply = () => {
    if (!active) {
      return;
    }
    generation += 1;
    clearTimer();
    schedule();
  };
  const start = () => {
    if (active || !params.enabled || params.abortSignal?.aborted) {
      return;
    }
    active = true;
    params.abortSignal?.addEventListener("abort", onAbort, { once: true });
    schedule();
  };
  return { isCurrentPayload, noteVisibleReply, start, stop };
}
