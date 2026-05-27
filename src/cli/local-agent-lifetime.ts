import { consumeRootOptionToken, FLAG_TERMINATOR } from "../infra/cli-root-options.js";

const LOCAL_AGENT_HARD_TIMEOUT_GRACE_MS = 30_000;
const LOCAL_AGENT_HARD_TIMEOUT_GRACE_SECONDS = LOCAL_AGENT_HARD_TIMEOUT_GRACE_MS / 1000;
const MAX_TIMER_SAFE_TIMEOUT_MS = 2_147_000_000;
const CLI_COMPLETION_STREAM_DRAIN_TIMEOUT_MS = 250;
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
  stderr?: Pick<NodeJS.WriteStream, "write">;
  exit?: (code?: number) => never | void;
};

type CliCompletionExitDeps = {
  argv?: string[];
  stdout?: Pick<NodeJS.WriteStream, "write"> &
    Partial<Pick<NodeJS.WriteStream, "destroyed" | "writableEnded">>;
  stderr?: Pick<NodeJS.WriteStream, "write"> &
    Partial<Pick<NodeJS.WriteStream, "destroyed" | "writableEnded">>;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  exit?: (code?: number) => never;
  drainTimeoutMs?: number;
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
  const stderr = deps.stderr ?? process.stderr;
  const exit = deps.exit ?? process.exit.bind(process);
  const timer = setTimer(() => {
    try {
      stderr.write(
        `local agent command timed out after ${plan.timeoutSeconds}s plus ${LOCAL_AGENT_HARD_TIMEOUT_GRACE_SECONDS}s grace\n`,
      );
    } catch {}
    try {
      exit(124);
    } catch {}
  }, plan.timeoutMs);
  timer.unref?.();
}

function waitForStreamFlush(
  stream: CliCompletionExitDeps["stdout"],
  deps: Required<Pick<CliCompletionExitDeps, "setTimeout" | "clearTimeout" | "drainTimeoutMs">>,
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
    timer.unref?.();
    try {
      stream.write("", finish);
    } catch {
      finish();
    }
  });
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
  const exit = deps.exit ?? process.exit.bind(process);
  exit(process.exitCode ?? 0);
}
