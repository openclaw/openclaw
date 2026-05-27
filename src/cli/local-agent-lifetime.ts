import { consumeRootOptionToken, FLAG_TERMINATOR } from "../infra/cli-root-options.js";

const LOCAL_AGENT_HARD_TIMEOUT_GRACE_MS = 30_000;
const LOCAL_AGENT_HARD_TIMEOUT_GRACE_SECONDS = LOCAL_AGENT_HARD_TIMEOUT_GRACE_MS / 1000;
const MAX_TIMER_SAFE_TIMEOUT_MS = 2_147_000_000;
const CLI_COMPLETION_STREAM_DRAIN_TIMEOUT_MS = 250;
const CLI_COMPLETION_FORCE_KILL_TIMEOUT_MS = 3_000;
const OTEL_PRE_EXIT_SYMBOL = Symbol.for("openclaw.otel.preExit");
const HELP_OR_VERSION_FLAGS = new Set(["-h", "--help", "-V", "--version"]);
const AGENT_VALUE_FLAGS = new Set([
  "-m",
  "--message",
  "-t",
  "--to",
  "--session-key",
  "--session-id",
  "--agent",
  "--model",
  "--thinking",
  "--verbose",
  "--channel",
  "--reply-to",
  "--reply-channel",
  "--reply-account",
  "--timeout",
]);

type LocalAgentHardTimeoutDeps = {
  argv?: string[];
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  stderr?: Pick<NodeJS.WriteStream, "write"> &
    Partial<Pick<NodeJS.WriteStream, "destroyed" | "writableEnded">>;
  exit?: (code?: number) => never | void;
  drainTimeoutMs?: number;
};

type CliCompletionExitDeps = {
  argv?: string[];
  globalObject?: Record<symbol, unknown>;
  stdout?: Pick<NodeJS.WriteStream, "write"> &
    Partial<Pick<NodeJS.WriteStream, "destroyed" | "writableEnded">>;
  stderr?: Pick<NodeJS.WriteStream, "write"> &
    Partial<Pick<NodeJS.WriteStream, "destroyed" | "writableEnded">>;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  exit?: (code?: number) => never | void;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  pid?: number;
  drainTimeoutMs?: number;
  forceKillTimeoutMs?: number;
};

type LocalAgentTimeoutPlan = {
  timeoutMs: number;
  timeoutSeconds: number;
};

type ParsedLocalAgentArgs = {
  hasHelpOrVersion: boolean;
  hasLocal: boolean;
  timeoutRaw: string | undefined;
};

type StreamFlushDeps = Required<
  Pick<CliCompletionExitDeps, "setTimeout" | "clearTimeout" | "drainTimeoutMs">
> & {
  unrefTimeout?: boolean;
};

function parseTimeoutSeconds(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function resolveHardTimeoutMs(timeoutSeconds: number): number {
  return Math.min(
    Math.floor(timeoutSeconds * 1000 + LOCAL_AGENT_HARD_TIMEOUT_GRACE_MS),
    MAX_TIMER_SAFE_TIMEOUT_MS,
  );
}

function splitOptionToken(arg: string): { flag: string; value: string | undefined } {
  const equalsIndex = arg.indexOf("=");
  return equalsIndex === -1
    ? { flag: arg, value: undefined }
    : { flag: arg.slice(0, equalsIndex), value: arg.slice(equalsIndex + 1) };
}

function findAgentArgsStart(argv: string[]): number | null {
  const args = argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg === FLAG_TERMINATOR) {
      break;
    }
    if (arg === "-v" || HELP_OR_VERSION_FLAGS.has(arg)) {
      return null;
    }
    const rootConsumed = consumeRootOptionToken(args, index);
    if (rootConsumed > 0) {
      index += rootConsumed - 1;
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    return arg === "agent" ? index + 3 : null;
  }
  return null;
}

function parseLocalAgentArgs(argv: string[]): ParsedLocalAgentArgs | null {
  const start = findAgentArgsStart(argv);
  if (start === null) {
    return null;
  }

  const parsed: ParsedLocalAgentArgs = {
    hasHelpOrVersion: false,
    hasLocal: false,
    timeoutRaw: undefined,
  };

  for (let index = start; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg || arg === FLAG_TERMINATOR) {
      break;
    }

    const { flag, value } = splitOptionToken(arg);
    if (HELP_OR_VERSION_FLAGS.has(flag)) {
      parsed.hasHelpOrVersion = true;
      continue;
    }
    if (flag === "--local") {
      parsed.hasLocal = true;
      continue;
    }
    if (!AGENT_VALUE_FLAGS.has(flag)) {
      continue;
    }
    const optionValue = value ?? argv[index + 1];
    if (flag === "--timeout") {
      parsed.timeoutRaw = optionValue;
    }
    if (value === undefined) {
      index += 1;
    }
  }

  return parsed;
}

export function resolveLocalAgentHardTimeoutPlan(
  deps: LocalAgentHardTimeoutDeps = {},
): LocalAgentTimeoutPlan | null {
  const argv = deps.argv ?? process.argv;
  const parsedArgs = parseLocalAgentArgs(argv);
  if (!parsedArgs || parsedArgs.hasHelpOrVersion || !parsedArgs.hasLocal) {
    return null;
  }
  const overrideSeconds = parseTimeoutSeconds(parsedArgs.timeoutRaw);
  if (overrideSeconds === undefined) {
    // Keep omitted --timeout on the existing configured/default agent timeout contract.
    return null;
  }
  if (overrideSeconds === 0) {
    return null;
  }
  return {
    timeoutMs: resolveHardTimeoutMs(overrideSeconds),
    timeoutSeconds: overrideSeconds,
  };
}

export function shouldForceExitAfterLocalAgentCompletion(
  deps: Pick<LocalAgentHardTimeoutDeps, "argv"> = {},
): boolean {
  const argv = deps.argv ?? process.argv;
  const parsedArgs = parseLocalAgentArgs(argv);
  return Boolean(parsedArgs && parsedArgs.hasLocal && !parsedArgs.hasHelpOrVersion);
}

export function armLocalAgentHardTimeout(deps: LocalAgentHardTimeoutDeps = {}): void {
  const plan = resolveLocalAgentHardTimeoutPlan(deps);
  if (!plan) {
    return;
  }
  const setTimer = deps.setTimeout ?? globalThis.setTimeout;
  const clearTimer = deps.clearTimeout ?? globalThis.clearTimeout;
  const stderr = deps.stderr ?? process.stderr;
  const exit = deps.exit ?? process.exit.bind(process);
  const timer = setTimer(() => {
    void writeAndFlushStream(
      stderr,
      `local agent command timed out after ${plan.timeoutSeconds}s plus ${LOCAL_AGENT_HARD_TIMEOUT_GRACE_SECONDS}s grace\n`,
      {
        setTimeout: setTimer,
        clearTimeout: clearTimer,
        drainTimeoutMs: deps.drainTimeoutMs ?? CLI_COMPLETION_STREAM_DRAIN_TIMEOUT_MS,
        unrefTimeout: false,
      },
    ).then(() => {
      try {
        exit(124);
      } catch {}
    });
  }, plan.timeoutMs);
  timer.unref?.();
}

function writeAndFlushStream(
  stream: CliCompletionExitDeps["stdout"],
  chunk: string,
  deps: StreamFlushDeps,
): Promise<void> {
  if (!stream || stream.destroyed || stream.writableEnded) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      if (timer) {
        deps.clearTimeout(timer);
      }
      resolve();
    };
    timer = deps.setTimeout(finish, deps.drainTimeoutMs);
    if (deps.unrefTimeout !== false) {
      timer.unref?.();
    }
    try {
      stream.write(chunk, finish);
    } catch {
      finish();
    }
  });
}

function waitForStreamFlush(
  stream: CliCompletionExitDeps["stdout"],
  deps: StreamFlushDeps,
): Promise<void> {
  return writeAndFlushStream(stream, "", deps);
}

async function flushOtelBeforeExit(deps: CliCompletionExitDeps): Promise<void> {
  const hook = (deps.globalObject ?? (globalThis as Record<symbol, unknown>))[OTEL_PRE_EXIT_SYMBOL];
  if (typeof hook !== "function") {
    return;
  }
  try {
    await hook();
  } catch {}
}

function armForceKillFallback(deps: CliCompletionExitDeps): void {
  const setTimer = deps.setTimeout ?? globalThis.setTimeout;
  const kill = deps.kill ?? process.kill.bind(process);
  const pid = deps.pid ?? process.pid;
  const timer = setTimer(() => {
    try {
      kill(pid, "SIGKILL");
    } catch {}
  }, deps.forceKillTimeoutMs ?? CLI_COMPLETION_FORCE_KILL_TIMEOUT_MS);
  timer.unref?.();
}

function resolveCurrentExitCode(): number {
  const code = process.exitCode;
  if (typeof code === "number" && Number.isFinite(code)) {
    return code;
  }
  if (typeof code === "string") {
    const parsed = Number.parseInt(code, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function exitWithCurrentCode(deps: CliCompletionExitDeps): void {
  const exit = deps.exit ?? process.exit.bind(process);
  exit(resolveCurrentExitCode());
}

export async function exitAfterLocalAgentCompletion(
  deps: CliCompletionExitDeps = {},
): Promise<void> {
  if (!shouldForceExitAfterLocalAgentCompletion(deps)) {
    return;
  }
  const drainDeps = {
    setTimeout: deps.setTimeout ?? globalThis.setTimeout,
    clearTimeout: deps.clearTimeout ?? globalThis.clearTimeout,
    drainTimeoutMs: deps.drainTimeoutMs ?? CLI_COMPLETION_STREAM_DRAIN_TIMEOUT_MS,
  };
  await Promise.all([
    waitForStreamFlush(deps.stdout ?? process.stdout, drainDeps),
    waitForStreamFlush(deps.stderr ?? process.stderr, drainDeps),
  ]);
  armForceKillFallback(deps);
  await flushOtelBeforeExit(deps);
  exitWithCurrentCode(deps);
}
