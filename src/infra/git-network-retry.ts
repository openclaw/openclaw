import { performance } from "node:perf_hooks";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { sleepWithAbort } from "./backoff.js";

type GitNetworkOperation = "fetch" | "ls-remote" | "clone";
type GitNetworkResult = {
  termination: string;
  code: number | null;
  stderr: string | Uint8Array;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  outputLimitExceeded?: boolean;
  outputErrorStream?: string;
  cleanup?: string;
};

const log = createSubsystemLogger("git/network");
const RETRY_DELAY_MS = 1_000;

/** Clone retries require destination cleanup by the clone owner, not this argv classifier. */
export function retryableGitNetworkOperation(
  args: readonly string[],
): GitNetworkOperation | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "-c" || arg === "-C" || arg === "--git-dir" || arg === "--work-tree") {
      index += 1;
    } else if (
      /^(?:-c.+|-C.+|--(?:git-dir|work-tree|config-env)=.+)$/u.test(arg) ||
      ["--no-optional-locks", "--no-lazy-fetch", "--no-replace-objects", "--bare"].includes(arg)
    ) {
      continue;
    } else {
      return arg === "fetch" || arg === "ls-remote" ? arg : undefined;
    }
  }
  return undefined;
}

function isTransientGitFailure(result: GitNetworkResult): boolean {
  if (
    result.termination !== "exit" ||
    result.code === null ||
    result.code === 0 ||
    result.killed ||
    result.signal ||
    result.outputLimitExceeded ||
    result.outputErrorStream ||
    result.cleanup === "uncertain"
  ) {
    return false;
  }
  const stderr =
    typeof result.stderr === "string" ? result.stderr : Buffer.from(result.stderr).toString("utf8");
  if (
    /authentication failed|permission denied|access denied|repository not found|could not read username|couldn't find remote ref|not our ref|certificate|host key verification failed|no space left|disk quota|cannot lock ref|bad object|returned error: (?:401|403|404)\b/iu.test(
      stderr,
    )
  ) {
    return false;
  }
  return /did not send all necessary objects|could not resolve (?:host|proxy)|temporary failure in name resolution|failed to connect|connection (?:reset|timed out|refused|closed)|remote end hung up unexpectedly|unexpected disconnect|early EOF|empty reply from server|TLS connection was non-properly terminated|SSL_ERROR_SYSCALL|HTTP\/2.*(?:stream|internal_error)|RPC failed; curl (?:5|6|7|18|28|35|52|55|56|92)\b|returned error: (?:408|429|500|502|503|504)\b/iu.test(
    stderr,
  );
}

/** Retry one settled network read inside its original deadline and caller-owned admission. */
export async function withGitNetworkRetry<T extends GitNetworkResult>(
  operation: GitNetworkOperation | undefined,
  options: { timeoutMs: number; signal?: AbortSignal; beforeRun?: () => void },
  run: (timeoutMs: number) => Promise<T>,
): Promise<T> {
  const started = performance.now();
  options.beforeRun?.();
  const result = await run(options.timeoutMs);
  if (!operation || !isTransientGitFailure(result)) {
    return result;
  }
  const cancelled = (): T => ({ ...result, code: null, signal: null, termination: "signal" });
  if (options.signal?.aborted) {
    return cancelled();
  }
  if (options.timeoutMs - (performance.now() - started) <= RETRY_DELAY_MS) {
    return result;
  }
  log.warn(`Git ${operation} hit a transient transport failure; retrying once`, {
    operation,
    attempt: 1,
    maxAttempts: 2,
    delayMs: RETRY_DELAY_MS,
    exitCode: result.code,
  });
  try {
    await sleepWithAbort(RETRY_DELAY_MS, options.signal);
  } catch (error) {
    if (options.signal?.aborted) {
      return cancelled();
    }
    throw error;
  }
  if (options.signal?.aborted) {
    return cancelled();
  }
  const remainingMs = Math.floor(options.timeoutMs - (performance.now() - started));
  if (remainingMs <= 0) {
    return result;
  }
  options.beforeRun?.();
  return await run(remainingMs);
}
