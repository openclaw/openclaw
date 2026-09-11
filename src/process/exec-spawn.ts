import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import process from "node:process";
import { execa, type Options as ExecaOptions, type ResultPromise } from "execa";
import { markOpenClawExecEnv } from "../infra/openclaw-exec-env.js";
import { mergeProcessEnv } from "../infra/process-env.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { forceKillChildProcessTree, isChildProcessTreeAlive } from "./child-process-tree.js";
import { resolveSafeChildProcessInvocation } from "./windows-command.js";

export const COMMAND_PROCESS_TREE_KILL_GRACE_MS = 300;

type ScopedCommandProcess = {
  stop: () => void;
  isSettled: () => boolean;
};

type CommandProcessScope = {
  stopped: boolean;
  children: Set<ScopedCommandProcess>;
  windowsChildrenSettled?: () => boolean;
};

const commandProcessScope = new AsyncLocalStorage<CommandProcessScope>();

export class CommandProcessScopeUnsettledError extends Error {
  constructor(cause?: unknown) {
    super(
      "Command process scope could not prove that every child stopped; recovery must retain its capture",
      { cause },
    );
    this.name = "CommandProcessScopeUnsettledError";
  }
}

/** Retire only settled operation ownership before an intentional process handoff. */
export async function retireCommandProcessJobForHandoff(): Promise<void> {
  if (process.platform !== "win32") {
    return;
  }
  const { retireRetainedWindowsProcessJob } =
    await import("./supervisor/service-child-windows-job-native.js");
  try {
    retireRetainedWindowsProcessJob();
  } catch (cause) {
    throw new CommandProcessScopeUnsettledError(cause);
  }
}

/** Terminal command deadlines stop and join their children before rollback. */
export async function withCommandProcessScope<T>(
  run: (stop: () => void) => Promise<T>,
): Promise<T> {
  const parent = commandProcessScope.getStore();
  const windowsJob =
    process.platform === "win32"
      ? await import("./supervisor/service-child-windows-job-native.js")
      : undefined;
  if (parent?.stopped) {
    throw new Error("Command process scope is closed");
  }
  windowsJob?.rearmRetainedWindowsProcessJob();
  const scope: CommandProcessScope = {
    stopped: false,
    children: new Set(),
    windowsChildrenSettled: windowsJob?.areRetainedWindowsProcessJobChildrenSettled,
  };
  let deadline = 0;
  let settled = false;
  const stop = () => {
    if (scope.stopped) {
      return;
    }
    scope.stopped = true;
    deadline = performance.now() + COMMAND_PROCESS_TREE_KILL_GRACE_MS;
    for (const child of scope.children) {
      child.stop();
    }
  };
  const nested = { stop, isSettled: () => settled };
  parent?.children.add(nested);
  return await commandProcessScope.run(scope, async () => {
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      outcome = { ok: true, value: await run(stop) };
    } catch (error) {
      outcome = { ok: false, error };
    }
    stop();
    while (scope.children.size > 0) {
      for (const child of scope.children) {
        if (child.isSettled()) {
          scope.children.delete(child);
        }
      }
      if (scope.children.size === 0) {
        break;
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw new CommandProcessScopeUnsettledError(outcome.ok ? undefined : outcome.error);
      }
      // Keep the timer referenced: an exited launcher is not descendant settlement.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(25, remaining));
      });
    }
    settled = true;
    parent?.children.delete(nested);
    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.value;
  });
}

function retainCommandProcess<OptionsType extends ExecaOptions>(
  scope: CommandProcessScope,
  child: ResultPromise<OptionsType>,
): void {
  const pid = child.pid;
  const nativeChild = child.nodeChildProcess;
  const windows = process.platform === "win32";
  const startedAt = pid !== undefined && !windows ? getFileLockProcessStartTime(pid) : null;
  let commandSettled = false;
  let treeGone = pid === undefined;
  const isSettled = () => {
    if (!treeGone) {
      treeGone = windows
        ? scope.windowsChildrenSettled?.() === true
        : !isChildProcessTreeAlive(nativeChild);
    }
    return treeGone && commandSettled;
  };
  const retained: ScopedCommandProcess = {
    isSettled,
    stop: () => {
      if (treeGone || windows || pid === undefined) {
        return;
      }
      // A live direct child holds PID custody even without a start-time probe.
      if (nativeChild.exitCode !== null || nativeChild.signalCode !== null) {
        const currentStart = getFileLockProcessStartTime(pid);
        if (currentStart !== null && currentStart !== startedAt) {
          return;
        }
      }
      forceKillChildProcessTree(nativeChild);
    },
  };
  scope.children.add(retained);
  const release = () => {
    commandSettled = true;
    if (isSettled()) {
      scope.children.delete(retained);
    }
  };
  void child.then(release, release);
}

export function shouldSpawnWithShell(params: {
  resolvedCommand: string;
  platform: NodeJS.Platform;
}): boolean {
  // SECURITY: never enable `shell` for argv-based execution.
  // `shell` routes through cmd.exe on Windows, which turns untrusted argv values
  // (like chat prompts passed as CLI args) into command-injection primitives.
  // If you need a shell, use an explicit shell-wrapper argv (e.g. `cmd.exe /c ...`)
  // and validate/escape at the call site.
  void params;
  return false;
}

type SpawnCommandOptions = ExecaOptions & {
  baseEnv?: NodeJS.ProcessEnv;
};

export function spawnCommandWithInvocation<
  OptionsType extends SpawnCommandOptions = SpawnCommandOptions,
>(
  argv: string[],
  options: OptionsType = {} as OptionsType,
): {
  child: ResultPromise<OptionsType>;
  invocation: ReturnType<typeof resolveSafeChildProcessInvocation>;
} {
  const scope = commandProcessScope.getStore();
  if (scope?.stopped) {
    throw new Error("Command process scope is closed");
  }
  const { baseEnv, env, windowsVerbatimArguments, ...execaOptions } = options;
  const commandEnv = resolveCommandEnv({ argv, baseEnv, env });
  const invocation = resolveSafeChildProcessInvocation({
    argv,
    cwd: execaOptions.cwd,
    env: commandEnv,
    windowsVerbatimArguments,
  });
  const child = execa(invocation.command, invocation.args, {
    ...execaOptions,
    ...(scope ? { killDescendants: true } : {}),
    env: commandEnv,
    extendEnv: false,
    shell: false,
    windowsHide: invocation.windowsHide,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  } as ExecaOptions) as unknown as ResultPromise<OptionsType>;
  if (scope) {
    retainCommandProcess(scope, child);
  }
  return { child, invocation };
}

/** Spawn through the canonical argv, environment, and Windows safety boundary. */
export function spawnCommand<OptionsType extends SpawnCommandOptions = SpawnCommandOptions>(
  argv: string[],
  options: OptionsType = {} as OptionsType,
): ResultPromise<OptionsType> {
  return spawnCommandWithInvocation(argv, options).child;
}

export function resolveCommandEnv(params: {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  baseEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): NodeJS.ProcessEnv {
  const baseEnv = params.baseEnv ?? process.env;
  const platform = params.platform ?? process.platform;
  const argv = params.argv;
  const shouldSuppressNpmFund = (() => {
    const cmd = path.basename(argv[0] ?? "");
    if (cmd === "npm" || cmd === "npm.cmd" || cmd === "npm.exe") {
      return true;
    }
    if (cmd === "node" || cmd === "node.exe") {
      const script = argv[1] ?? "";
      return script.includes("npm-cli.js");
    }
    return false;
  })();

  const resolvedEnv = mergeProcessEnv([baseEnv, params.env], platform);
  if (shouldSuppressNpmFund) {
    if (resolvedEnv.NPM_CONFIG_FUND == null) {
      resolvedEnv.NPM_CONFIG_FUND = "false";
    }
    if (resolvedEnv.npm_config_fund == null) {
      resolvedEnv.npm_config_fund = "false";
    }
  }
  return markOpenClawExecEnv(resolvedEnv);
}
