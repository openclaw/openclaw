import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
// Fire-and-forget hook helpers schedule hook work without blocking hot paths.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { logVerbose } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const DEFAULT_MAX_CONCURRENT_FIRE_AND_FORGET_HOOKS = 16;
const DEFAULT_MAX_QUEUED_FIRE_AND_FORGET_HOOKS = 256;
const DEFAULT_FIRE_AND_FORGET_HOOK_TIMEOUT_MS = 2_000;
const MAX_HOOK_LOG_MESSAGE_LENGTH = 500;

type FireAndForgetHookJob = {
  task: () => Promise<unknown>;
  label: string;
  logger: (message: string) => void;
  timeoutMs: number;
};

type FireAndForgetHookState = {
  active: number;
  queue: FireAndForgetHookJob[];
};

/** Queue limits for bounded fire-and-forget hook execution. */
type FireAndForgetBoundedHookOptions = {
  maxConcurrency?: number;
  maxQueue?: number;
  timeoutMs?: number;
};

const getFireAndForgetHookState = () =>
  resolveGlobalSingleton<FireAndForgetHookState>(
    Symbol.for("openclaw.fireAndForgetHookState"),
    () => ({
      active: 0,
      queue: [],
    }),
  );

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Format hook errors as bounded single-line log messages with secrets redacted upstream. */
export function formatHookErrorForLog(err: unknown): string {
  const formatted = formatErrorMessage(err)
    .replace(/\p{Cc}/gu, (char) => (char.charCodeAt(0) <= 0x7f ? " " : char))
    .replace(/\s+/g, " ")
    .trim();
  return truncateUtf16Safe(formatted || "unknown error", MAX_HOOK_LOG_MESSAGE_LENGTH);
}

/** Run a hook promise without awaiting it, logging rejection safely. */
export function fireAndForgetHook(
  task: Promise<unknown>,
  label: string,
  logger: (message: string) => void = logVerbose,
): void {
  void task.catch((err: unknown) => {
    logger(`${label}: ${formatHookErrorForLog(err)}`);
  });
}

function runFireAndForgetHookJob(
  state: FireAndForgetHookState,
  { task, ...job }: FireAndForgetHookJob,
  limits: { maxConcurrency: number },
): void {
  // Pending observers need logging metadata, not the invoked factory's captured inputs.
  state.active += 1;
  let didLogTimeout = false;
  const timeout =
    job.timeoutMs > 0
      ? setTimeout(() => {
          // Timeout is informational only; the hook promise may still settle
          // later, but the log should not double-report an eventual rejection.
          didLogTimeout = true;
          job.logger(`${job.label}: timed out after ${job.timeoutMs}ms`);
        }, job.timeoutMs)
      : undefined;

  void Promise.resolve()
    .then(task)
    .catch((err: unknown) => {
      if (!didLogTimeout) {
        job.logger(`${job.label}: ${formatHookErrorForLog(err)}`);
      }
    })
    .finally(() => {
      if (timeout) {
        clearTimeout(timeout);
      }
      state.active -= 1;
      drainFireAndForgetHookQueue(state, limits);
    });
}

function drainFireAndForgetHookQueue(
  state: FireAndForgetHookState,
  limits: { maxConcurrency: number },
): void {
  while (state.active < limits.maxConcurrency) {
    const next = state.queue.shift();
    if (!next) {
      return;
    }
    runFireAndForgetHookJob(state, next, limits);
  }
}

/** Queue a fire-and-forget hook with bounded concurrency, queue depth, and timeout logs. */
export function fireAndForgetBoundedHook(
  task: () => Promise<unknown>,
  label: string,
  logger: (message: string) => void = logVerbose,
  options: FireAndForgetBoundedHookOptions = {},
): void {
  const state = getFireAndForgetHookState();
  const maxConcurrency = positiveIntegerOrDefault(
    options.maxConcurrency,
    DEFAULT_MAX_CONCURRENT_FIRE_AND_FORGET_HOOKS,
  );
  const maxQueue = positiveIntegerOrDefault(
    options.maxQueue,
    DEFAULT_MAX_QUEUED_FIRE_AND_FORGET_HOOKS,
  );
  const timeoutMs = resolveTimerTimeoutMs(
    positiveIntegerOrDefault(options.timeoutMs, DEFAULT_FIRE_AND_FORGET_HOOK_TIMEOUT_MS),
    DEFAULT_FIRE_AND_FORGET_HOOK_TIMEOUT_MS,
  );

  if (state.active >= maxConcurrency && state.queue.length >= maxQueue) {
    logger(`${label}: queue full; dropping hook`);
    return;
  }

  state.queue.push({ task, label, logger, timeoutMs });
  drainFireAndForgetHookQueue(state, { maxConcurrency });
}
