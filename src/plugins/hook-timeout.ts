import { clampPositiveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { racePromiseWithAbortSignal, raceWithTimeout } from "../../packages/retry/src/index.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import type { PluginHookRegistration } from "./hook-types.js";

export const withHookTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  optionsResult: { unref?: boolean; signal?: AbortSignal } = {},
): Promise<T> => {
  // The handler has started. Retain its work without replacing the raced promise
  // if its caller's scope has already closed; hook policy still owns its errors.
  void trackAsyncWork(() => promise).catch(() => {});
  return await raceWithTimeout(
    promise,
    timeoutMs,
    () => {
      throw new Error(`timed out after ${timeoutMs}ms`);
    },
    { ref: !optionsResult.unref, signal: optionsResult.signal },
  );
};

export const awaitHook = <T>(
  hook: PluginHookRegistration,
  promise: Promise<T>,
  defaultTimeoutMs?: number,
  timeoutOptions?: { unref?: boolean; signal?: AbortSignal },
): Promise<T> => {
  const timeoutMs =
    clampPositiveTimerTimeoutMs(hook.timeoutMs) ?? clampPositiveTimerTimeoutMs(defaultTimeoutMs);
  return timeoutMs
    ? withHookTimeout(promise, timeoutMs, timeoutOptions)
    : racePromiseWithAbortSignal(promise, timeoutOptions?.signal);
};
