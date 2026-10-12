import type { CronAgentAdmissionDisposition } from "../../cron/isolated-agent/run.types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { HookAgentCompletion, HookAgentDispatchResult } from "../hooks.types.js";

const HOOK_AGENT_START_ADMISSION_TIMEOUT_ERROR =
  "hook agent run did not start before admission timeout";
const HOOK_AGENT_REQUEST_DISCONNECTED_ERROR = "hook request disconnected before agent run started";
const HOOK_AGENT_SESSION_CONFLICT_ERROR =
  "hook agent run was rejected because the target session changed";
const HOOK_AGENT_PREPARATION_ERROR = "hook agent run failed before entering the agent runner";

export function createHookAdmissionFailure(params: {
  runId: string;
  disposition?: CronAgentAdmissionDisposition;
  statusCode?: 409 | 502 | 503;
}): HookAgentDispatchResult {
  const statusCode = params.statusCode ?? (params.disposition === "session-conflict" ? 409 : 502);
  return {
    ok: false,
    statusCode,
    error:
      statusCode === 409
        ? HOOK_AGENT_SESSION_CONFLICT_ERROR
        : statusCode === 503
          ? HOOK_AGENT_START_ADMISSION_TIMEOUT_ERROR
          : HOOK_AGENT_PREPARATION_ERROR,
    runId: params.runId,
  };
}

/** Owns pending hook cancellation until lane placement or runner entry accepts the run. */
export function createHookAgentAdmission(params: {
  runId: string;
  completion: Promise<HookAgentCompletion>;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  onSettle?: (result: HookAgentDispatchResult) => void;
}) {
  const result = createDeferredCore<HookAgentDispatchResult>();
  const startup = new AbortController();
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settle = (outcome: HookAgentDispatchResult) => {
    if (settled) {
      return;
    }
    settled = true;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    // Accepted work stays independent of the caller. Drop the request listener
    // before resolving so a later disconnect cannot abort the runner.
    params.abortSignal?.removeEventListener("abort", abortPendingAdmission);
    params.onSettle?.(outcome);
    result.resolve(outcome);
  };
  const abortPendingAdmission = () => {
    if (settled) {
      return;
    }
    startup.abort(params.abortSignal?.reason);
    settle({
      ok: false,
      statusCode: 503,
      error: HOOK_AGENT_REQUEST_DISCONNECTED_ERROR,
      runId: params.runId,
    });
  };
  // Background fan-out omits the deadline: replay and producer redelivery keep
  // slow items instead of cold-starting every retry.
  if (params.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      startup.abort(new Error(HOOK_AGENT_START_ADMISSION_TIMEOUT_ERROR));
      settle(createHookAdmissionFailure({ runId: params.runId, statusCode: 503 }));
    }, params.timeoutMs);
    timer.unref?.();
  }
  params.abortSignal?.addEventListener("abort", abortPendingAdmission, { once: true });
  if (params.abortSignal?.aborted) {
    abortPendingAdmission();
  }
  return {
    result: result.promise,
    signal: startup.signal,
    get settled() {
      return settled;
    },
    settle,
    accept: () => {
      startup.signal.throwIfAborted();
      settle({ ok: true, runId: params.runId, completion: params.completion });
    },
  };
}
