import { performance } from "node:perf_hooks";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { sleepWithAbort } from "./backoff.js";

type GitNetworkOperation = "fetch" | "ls-remote" | "clone";
export type GitOperationStarter = <T>(operation: () => T) => Promise<Awaited<T>>;
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
const DEFAULT_RETRY_DELAYS_MS = [1_000];
export const UPDATE_GIT_RETRY_DELAYS_MS = [1_000, 5_000, 15_000] as const;

/** Resolve owner-prepared Git argv without mistaking a global option value for a command. */
export function gitCommandName(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(arg)) {
      index += 1;
    } else if (
      /^(?:-c.+|-C.+|--(?:git-dir|work-tree|namespace|config-env|attr-source)=.+)$/u.test(arg) ||
      [
        "--no-optional-locks",
        "--no-lazy-fetch",
        "--no-replace-objects",
        "--bare",
        "--literal-pathspecs",
        "--no-pager",
      ].includes(arg)
    ) {
      continue;
    } else {
      return arg;
    }
  }
  return undefined;
}

/** Clone retries require destination cleanup by the clone owner, not this argv classifier. */
export function retryableGitNetworkOperation(
  args: readonly string[],
): GitNetworkOperation | undefined {
  const command = gitCommandName(args);
  return command === "fetch" || command === "ls-remote" ? command : undefined;
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
    /authentication failed|permission denied|access denied|repository not found|could not read username|couldn't find remote ref|not our ref|certificate|host key verification failed|no space left|disk quota|cannot lock ref|bad object|checksum|corrupt|inflate:|hash mismatch|SHA(?:1|256) mismatch|CRC mismatch|returned error: (?:401|403|404)\b/iu.test(
      stderr,
    )
  ) {
    return false;
  }
  return /did not send all necessary objects|could not resolve (?:host|proxy)|temporary failure in name resolution|failed to connect|connection (?:reset|timed out|refused|closed)|transfer closed with \d+ bytes remaining to read|remote end hung up unexpectedly|unexpected disconnect|\bEOF\b|ECONNRESET|ETIMEDOUT|empty reply from server|TLS connection was non-properly terminated|SSL_ERROR_SYSCALL|HTTP\/2.*(?:stream|internal_error)|RPC failed; curl (?:5|6|7|18|28|35|52|55|56|92)\b|returned error: (?:408|429|5\d\d)\b/iu.test(
    stderr,
  );
}

/** Retry settled network reads within their original deadline and caller-owned admission. */
export async function withGitNetworkRetry<T extends GitNetworkResult>(
  operation: GitNetworkOperation | undefined,
  options: {
    timeoutMs?: number;
    retryDelaysMs?: readonly number[];
    signal?: AbortSignal;
    beforeRun?: () => void;
    startRun?: GitOperationStarter;
  },
  run: (timeoutMs: number | undefined) => Promise<T>,
): Promise<T> {
  const deadline = performance.now() + (options.timeoutMs ?? Infinity);
  const attempt = (timeoutMs: number | undefined) => {
    const start = () => {
      options.beforeRun?.();
      return run(timeoutMs);
    };
    return options.startRun ? options.startRun(start) : start();
  };
  let result = await attempt(options.timeoutMs);
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const cancelled = (): T => ({ ...result, code: null, signal: null, termination: "signal" });
  for (const [index, delayMs] of delays.entries()) {
    if (!operation || !isTransientGitFailure(result)) {
      break;
    }
    if (options.signal?.aborted) {
      return cancelled();
    }
    if (deadline - performance.now() <= delayMs) {
      break;
    }
    log.warn(`Git ${operation} hit a transient failure; retrying`, {
      operation,
      attempt: index + 1,
      maxAttempts: delays.length + 1,
      delayMs,
      exitCode: result.code,
    });
    try {
      await sleepWithAbort(delayMs, options.signal);
    } catch (error) {
      if (options.signal?.aborted) {
        return cancelled();
      }
      throw error;
    }
    if (options.signal?.aborted) {
      return cancelled();
    }
    const remainingMs = Math.floor(deadline - performance.now());
    if (remainingMs <= 0) {
      break;
    }
    result = await attempt(options.timeoutMs === undefined ? undefined : remainingMs);
  }
  return result;
}
