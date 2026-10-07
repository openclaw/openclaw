import type { ServerResponse } from "node:http";
import type { HookAgentCompletion, HookAgentDispatchResult } from "../hooks.types.js";
import { sendJson } from "../http-common.js";

// gog's hook HTTP client aborts after 10 seconds and treats the abort as a
// delivery failure. Keep the response deadline below that producer timeout.
export const HOOK_FAN_OUT_RESPONSE_DEADLINE_MS = 8_000;

export type WakeResult = { eventOutcome: "queued" | "coalesced" };

const FAN_OUT_PENDING = Symbol("hook-fanout-pending");
type FanOutSettled = HookAgentDispatchResult | typeof FAN_OUT_PENDING;

export async function settleFanOutDispatches(
  dispatches: Array<Promise<HookAgentDispatchResult>>,
  deadlineMs: number,
): Promise<FanOutSettled[]> {
  // Rejections must settle to failures even when the race already resolved
  // pending, or the detached dispatch promise rejects unhandled later.
  const guarded = dispatches.map((dispatch) =>
    dispatch.catch((err: unknown): HookAgentDispatchResult => ({
      ok: false,
      statusCode: 502,
      error: String(err),
    })),
  );
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof FAN_OUT_PENDING>((resolve) => {
    deadlineTimer = setTimeout(() => resolve(FAN_OUT_PENDING), deadlineMs);
    deadlineTimer.unref?.();
  });
  try {
    return await Promise.all(guarded.map((dispatch) => Promise.race([dispatch, deadline])));
  } finally {
    if (deadlineTimer) {
      clearTimeout(deadlineTimer);
    }
  }
}

export function sendAgentResult(
  res: ServerResponse,
  result: HookAgentDispatchResult,
  extra?: Partial<WakeResult>,
  waitForCompletion = false,
): void | Promise<void> {
  if (!result.ok) {
    const { statusCode, ...body } = result;
    sendJson(res, statusCode, { ...body, ...extra });
    return;
  }
  const send = (completion?: HookAgentCompletion) =>
    sendJson(res, 200, {
      ok: true,
      runId: result.runId,
      ...extra,
      ...(completion ? { completion } : {}),
    });
  return waitForCompletion ? result.completion.then(send) : send();
}

export function sendFanOutResult(res: ServerResponse, settled: FanOutSettled[], wake?: WakeResult) {
  const first = settled[0];
  if (settled.length === 1 && first !== undefined && first !== FAN_OUT_PENDING) {
    // Single-item batches keep the exact single-dispatch response shape.
    void sendAgentResult(res, first, wake);
    return;
  }
  const runIds: string[] = [];
  const failures: Array<Extract<HookAgentDispatchResult, { ok: false }>> = [];
  let pending = 0;
  for (const result of settled) {
    if (result === FAN_OUT_PENDING) {
      pending += 1;
    } else if (result.ok) {
      runIds.push(result.runId);
    } else {
      failures.push(result);
    }
  }
  if (failures.length === 0 && pending === 0) {
    const result = { ok: true, runId: runIds[0], runIds, dispatched: runIds.length };
    sendJson(res, 200, { ...result, ...wake });
    return;
  }
  // A non-2xx makes the producer redeliver the batch; already-dispatched items
  // then replay from the cache instead of running twice.
  const failure = failures[0];
  sendJson(res, failure ? failure.statusCode : 503, {
    ok: false,
    error: `hook fan-out incomplete: ${runIds.length}/${settled.length} dispatched, ${failures.length} failed, ${pending} pending`,
    runIds,
    ...(failures.length > 0 ? { errors: failures.slice(0, 5).map((entry) => entry.error) } : {}),
    ...wake,
  });
}
