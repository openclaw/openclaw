import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { theme } from "../../packages/terminal-core/src/theme.js";
import type { RuntimeEnv } from "../runtime.js";
import { sleepWithAbort } from "./backoff.js";

export type TransportReadyResult = {
  ok: boolean;
  error?: string | null;
};

export type WaitForTransportReadyParams = {
  label: string;
  timeoutMs: number;
  logAfterMs?: number;
  logIntervalMs?: number;
  pollIntervalMs?: number;
  abortSignal?: AbortSignal;
  runtime: RuntimeEnv;
  check: () => Promise<TransportReadyResult>;
};

/** Polls until ready, timed out, or aborted, with bounded logging through the runtime sink. */
export async function waitForTransportReady(params: WaitForTransportReadyParams): Promise<void> {
  const started = Date.now();
  const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 0, 0);
  const deadline = started + timeoutMs;
  const logAfterMs = resolveTimerTimeoutMs(params.logAfterMs, timeoutMs, 0);
  const logIntervalMs = resolveTimerTimeoutMs(params.logIntervalMs, 30_000, 1_000);
  const pollIntervalMs = resolveTimerTimeoutMs(params.pollIntervalMs, 150, 50);
  let nextLogAt = started + logAfterMs;
  let lastError: string | null = null;

  while (true) {
    if (params.abortSignal?.aborted) {
      return;
    }
    const res = await params.check();
    if (res.ok || params.abortSignal?.aborted) {
      return;
    }
    lastError = res.error ?? null;

    const now = Date.now();
    if (now >= deadline) {
      break;
    }
    if (now >= nextLogAt) {
      const elapsedMs = now - started;
      params.runtime.error?.(
        theme.error(
          `${params.label} not ready after ${elapsedMs}ms (${lastError ?? "unknown error"})`,
        ),
      );
      nextLogAt = now + logIntervalMs;
    }

    try {
      // Abort is cooperative: `sleepWithAbort` may throw on abort, but callers treat abort as
      // a quiet stop rather than a transport failure.
      await sleepWithAbort(pollIntervalMs, params.abortSignal);
    } catch (err) {
      if (params.abortSignal?.aborted) {
        return;
      }
      throw err;
    }
  }

  params.runtime.error?.(
    theme.error(`${params.label} not ready after ${timeoutMs}ms (${lastError ?? "unknown error"})`),
  );
  throw new Error(`${params.label} not ready (${lastError ?? "unknown error"})`);
}
