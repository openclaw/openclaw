import { logVerbose, shouldLogVerbose } from "../globals.js";
import type { BackoffPolicy } from "../infra/backoff.js";
import { computeBackoff, sleepWithAbort } from "../infra/backoff.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  detectSignalApiMode,
  pollSignalJsonRpc,
  type SignalSseEvent,
  streamSignalEvents,
} from "./client.js";

const DEFAULT_RECONNECT_POLICY: BackoffPolicy = {
  initialMs: 1_000,
  maxMs: 10_000,
  factor: 2,
  jitter: 0.2,
};

type RunSignalSseLoopParams = {
  baseUrl: string;
  account?: string;
  abortSignal?: AbortSignal;
  runtime: RuntimeEnv;
  onEvent: (event: SignalSseEvent) => void;
  policy?: Partial<BackoffPolicy>;
};

export async function runSignalSseLoop({
  baseUrl,
  account,
  abortSignal,
  runtime,
  onEvent,
  policy,
}: RunSignalSseLoopParams) {
  const reconnectPolicy = {
    ...DEFAULT_RECONNECT_POLICY,
    ...policy,
  };
  let reconnectAttempts = 0;

  const logReconnectVerbose = (message: string) => {
    if (!shouldLogVerbose()) {
      return;
    }
    logVerbose(message);
  };

  while (!abortSignal?.aborted) {
    try {
      await streamSignalEvents({
        baseUrl,
        account,
        abortSignal,
        onEvent: (event) => {
          reconnectAttempts = 0;
          onEvent(event);
        },
      });
      if (abortSignal?.aborted) {
        return;
      }
      reconnectAttempts += 1;
      const delayMs = computeBackoff(reconnectPolicy, reconnectAttempts);
      logReconnectVerbose(`Signal SSE stream ended, reconnecting in ${delayMs / 1000}s...`);
      await sleepWithAbort(delayMs, abortSignal);
    } catch (err) {
      if (abortSignal?.aborted) {
        return;
      }
      runtime.error?.(`Signal SSE stream error: ${String(err)}`);
      reconnectAttempts += 1;
      const delayMs = computeBackoff(reconnectPolicy, reconnectAttempts);
      runtime.log?.(`Signal SSE connection lost, reconnecting in ${delayMs / 1000}s...`);
      try {
        await sleepWithAbort(delayMs, abortSignal);
      } catch (sleepErr) {
        if (abortSignal?.aborted) {
          return;
        }
        throw sleepErr;
      }
    }
  }
}

type RunSignalReceiveLoopParams = RunSignalSseLoopParams;

/**
 * Auto-detecting receive loop.  Probes the daemon once at startup: if
 * /api/v1/events is available (bbernhard REST wrapper) it uses SSE;
 * otherwise it falls back to the native signal-cli JSON-RPC long-poll.
 */
export async function runSignalReceiveLoop(params: RunSignalReceiveLoopParams) {
  const mode = await detectSignalApiMode(params.baseUrl);
  params.runtime.log?.(`Signal receive mode: ${mode}`);

  if (mode === "sse") {
    return runSignalSseLoop(params);
  }
  return runSignalJsonRpcPollLoop(params);
}

async function runSignalJsonRpcPollLoop({
  baseUrl,
  account,
  abortSignal,
  runtime,
  onEvent,
  policy,
}: RunSignalReceiveLoopParams) {
  const reconnectPolicy = {
    ...DEFAULT_RECONNECT_POLICY,
    ...policy,
  };
  let consecutiveErrors = 0;

  while (!abortSignal?.aborted) {
    try {
      await pollSignalJsonRpc({
        baseUrl,
        account,
        abortSignal,
        onEvent,
        pollTimeoutSec: 10,
      });
      consecutiveErrors = 0;
    } catch (err) {
      if (abortSignal?.aborted) {
        return;
      }
      consecutiveErrors += 1;
      runtime.error?.(`Signal JSON-RPC poll error: ${String(err)}`);
      const delayMs = computeBackoff(reconnectPolicy, consecutiveErrors);
      runtime.log?.(`Signal JSON-RPC poll failed, retrying in ${delayMs / 1000}s...`);
      try {
        await sleepWithAbort(delayMs, abortSignal);
      } catch (sleepErr) {
        if (abortSignal?.aborted) {
          return;
        }
        throw sleepErr;
      }
    }
  }
}
