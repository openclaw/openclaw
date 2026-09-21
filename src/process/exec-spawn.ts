import { AsyncLocalStorage } from "node:async_hooks";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { execa } from "execa";
import { markOpenClawExecEnv } from "../infra/openclaw-exec-env.js";
import { mergeProcessEnv } from "../infra/process-env.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { isChildProcessTreeAlive } from "./child-process-tree.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
  type SpawnResult,
} from "./exec-result.js";
import { killProcessTree } from "./kill-tree.js";
import { BrokerChild } from "./spawn-broker/child.js";
import { getSpawnBroker } from "./spawn-broker/context.js";
import {
  brokerExecaOptions,
  spawnBrokerCommand,
  type CommandSubprocess,
} from "./spawn-broker/execa-client.js";
import type { CommandSpawnOptions } from "./spawn-broker/execa-types.js";
import { recordChildProcessSpawn } from "./spawn-utils.js";
import { resolveSafeChildProcessInvocation } from "./windows-command.js";

export const COMMAND_PROCESS_TREE_KILL_GRACE_MS = 300;

/** Remote PID and pipes arrive together before admission or stream subscription. */
export async function waitForCommandSpawn(
  child: { nodeChildProcess: ChildProcess } & PromiseLike<unknown>,
): Promise<void> {
  if (child.nodeChildProcess instanceof BrokerChild) {
    try {
      await child.nodeChildProcess.ready();
    } catch {
      // Execa owns launch-error metadata even when native spawn produced no PID.
      await child;
    }
  }
}

type ScopedCommand = {
  stop: () => void;
  settle: () => Promise<void>;
};

type CommandProcessScope = {
  signal: AbortSignal;
  children: Set<ScopedCommand>;
  cleanups: Set<Promise<void>>;
  failure?: { error: unknown };
};

const commandProcessScope = new AsyncLocalStorage<CommandProcessScope>();

export function resolveCommandProcessSignal(signal?: AbortSignal): AbortSignal | undefined {
  const inherited = commandProcessScope.getStore()?.signal;
  return inherited ? AbortSignal.any(signal ? [inherited, signal] : [inherited]) : signal;
}

/** Cleanup helpers must outlive cancellation of the commands they are settling. */
export function runOutsideCommandProcessScope<T>(run: () => T): T {
  return commandProcessScope.exit(run);
}

/** Join the command owner's cleanup separately from its bounded caller result. */
export function retainCommandProcessCleanup(cleanup: Promise<SpawnResult["cleanup"] | void>): void {
  const scope = commandProcessScope.getStore();
  if (!scope) {
    return;
  }
  const settled = cleanup.then(
    (result) => {
      if (result === "uncertain") {
        scope.failure ??= { error: new CommandProcessCleanupError() };
      }
    },
    (error: unknown) => {
      scope.failure ??= { error };
    },
  );
  scope.cleanups.add(settled);
  void settled.then(() => scope.cleanups.delete(settled));
}

/** Terminal command deadlines stop and join children before the caller permits rollback. */
export async function withCommandProcessScope<T>(
  run: (stop: () => void) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const parent = commandProcessScope.getStore();
  const controller = new AbortController();
  const inherited = resolveCommandProcessSignal(signal);
  const scope: CommandProcessScope = {
    signal: inherited ? AbortSignal.any([inherited, controller.signal]) : controller.signal,
    children: new Set(),
    cleanups: new Set(),
  };
  const stop = () => {
    controller.abort();
    for (const child of scope.children) {
      try {
        child.stop();
      } catch (error) {
        scope.failure ??= { error };
      }
    }
  };
  let settlement: Promise<void> | undefined;
  const settle = () => (settlement ??= settleCommands());
  async function settleCommands() {
    stop();
    await Promise.all(
      [...scope.children].map(async (child) => {
        try {
          await child.settle();
        } catch (error) {
          scope.failure ??= { error };
        }
      }),
    );
    while (scope.cleanups.size > 0) {
      await Promise.all(scope.cleanups);
    }
  }
  const nested: ScopedCommand = {
    stop,
    async settle() {
      await settle();
      if (scope.failure) {
        throw new CommandProcessCleanupError({ cause: scope.failure.error });
      }
    },
  };
  // Parent settlement follows admitted commands and declared cleanup even when
  // the callback ignores cancellation. Closed scopes refuse new commands.
  parent?.children.add(nested);
  const completion = commandProcessScope.run(scope, async () => {
    let outcome: { result: T } | { error: unknown };
    try {
      outcome = { result: await run(stop) };
    } catch (error) {
      outcome = { error };
      if (parent && hasCommandProcessCleanupError(error)) {
        parent.failure ??= { error };
      }
    }
    await settle();
    if (scope.failure) {
      const cause =
        "error" in outcome
          ? outcome.error === scope.failure.error
            ? outcome.error
            : new AggregateError(
                [outcome.error, scope.failure.error],
                "Command and cleanup failed",
                { cause: outcome.error },
              )
          : scope.failure.error;
      throw new CommandProcessCleanupError({ cause });
    }
    if ("error" in outcome) {
      throw outcome.error;
    }
    return outcome.result;
  });
  void completion.then(
    () => parent?.children.delete(nested),
    (error: unknown) => {
      if (parent && hasCommandProcessCleanupError(error)) {
        parent.failure ??= { error };
      }
      parent?.children.delete(nested);
    },
  );
  return await completion;
}

function retainCommandProcess(
  scope: CommandProcessScope,
  child: { pid?: number; nodeChildProcess: ChildProcess } & PromiseLike<unknown>,
): void {
  let pid: number | undefined;
  let startedAt: number | null = null;
  let stopped = false;
  const nativeChild = child.nodeChildProcess;
  let observedExit = nativeChild.exitCode != null || nativeChild.signalCode != null;
  const onExit = () => {
    observedExit = true;
  };
  nativeChild.once("exit", onExit);
  const closed = nativeChild instanceof BrokerChild ? nativeChild.waitForClose() : undefined;
  const stop = () => {
    if (stopped || pid === undefined || process.platform === "win32") {
      return;
    }
    stopped = true;
    // A live direct child holds PID custody even when its optional timestamp probe failed.
    if (nativeChild.exitCode !== null || nativeChild.signalCode !== null) {
      const currentStart = getFileLockProcessStartTime(pid);
      if (currentStart !== null && currentStart !== startedAt) {
        throw new CommandProcessCleanupError();
      }
    }
    killProcessTree(pid, { detached: true, force: true });
  };
  const initialize = () => {
    pid = child.pid;
    if (pid !== undefined && process.platform !== "win32") {
      startedAt = getFileLockProcessStartTime(pid);
      if (scope.signal.aborted) {
        stop();
      }
    }
  };
  const readiness =
    child.nodeChildProcess instanceof BrokerChild && child.pid === undefined
      ? child.nodeChildProcess.ready().then(initialize)
      : Promise.resolve(initialize());
  // Admission is retained before remote readiness, and rejection is observed immediately.
  const completed = Promise.resolve(child)
    .then(
      () => undefined,
      () => undefined,
    )
    .then(async () => {
      await closed;
      nativeChild.removeListener("exit", onExit);
    });
  const initialized = readiness.catch((error: unknown) => {
    if (!(nativeChild instanceof BrokerChild && nativeChild.notStarted)) {
      scope.failure ??= { error };
    }
  });
  const owned: ScopedCommand = {
    stop,
    async settle() {
      await initialized;
      await completed;
      if (pid === undefined) {
        if (nativeChild instanceof BrokerChild && !nativeChild.notStarted) {
          throw new CommandProcessCleanupError();
        }
        return;
      }
      // Windows executable finalizers retain a Job until process exit. POSIX
      // pipe closure is not extinction: observe this exact group after its stop.
      if (process.platform === "win32") {
        if (!observedExit) {
          throw new CommandProcessCleanupError();
        }
        return;
      }
      const deadline = Date.now() + COMMAND_PROCESS_TREE_KILL_GRACE_MS;
      while (isChildProcessTreeAlive({ pid })) {
        const currentStart = getFileLockProcessStartTime(pid);
        const remaining = deadline - Date.now();
        if ((currentStart !== null && currentStart !== startedAt) || remaining <= 0) {
          throw new CommandProcessCleanupError();
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, Math.min(25, remaining));
        });
      }
    },
  };
  scope.children.add(owned);
  void completed.then(() => {
    if (pid !== undefined && process.platform !== "win32" && !isChildProcessTreeAlive({ pid })) {
      scope.children.delete(owned);
    }
  });
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

type SpawnCommandOptions = CommandSpawnOptions & {
  baseEnv?: NodeJS.ProcessEnv;
  /** The command runner routes scope cancellation through its termination owner. */
  inheritScopeCancellation?: boolean;
};

export function spawnCommandWithInvocation<
  OptionsType extends SpawnCommandOptions = SpawnCommandOptions,
>(
  argv: string[],
  options: OptionsType = {} as OptionsType,
): {
  child: CommandSubprocess<OptionsType>;
  invocation: ReturnType<typeof resolveSafeChildProcessInvocation>;
} {
  const scope = commandProcessScope.getStore();
  if (scope?.signal.aborted) {
    throw new Error("Command process scope is closed");
  }
  const sourceOptions: SpawnCommandOptions = options;
  const {
    baseEnv,
    env,
    windowsVerbatimArguments,
    cancelSignal,
    inheritScopeCancellation = true,
    ...execaOptions
  } = sourceOptions;
  const commandEnv = resolveCommandEnv({ argv, baseEnv, env });
  const invocation = resolveSafeChildProcessInvocation({
    argv,
    cwd: execaOptions.cwd,
    env: commandEnv,
    windowsVerbatimArguments,
  });
  const commandOptions: CommandSpawnOptions = {
    ...execaOptions,
    cancelSignal: inheritScopeCancellation
      ? resolveCommandProcessSignal(cancelSignal)
      : cancelSignal,
    ...(scope ? { killDescendants: true } : {}),
    env: commandEnv,
    extendEnv: false,
    shell: false,
    windowsHide: invocation.windowsHide,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  };
  const broker = getSpawnBroker();
  // CLI and other platforms have no broker scope. Independent applications and
  // native descriptors retain their explicitly selected in-process transport.
  const remoteOptions = broker ? brokerExecaOptions(commandOptions) : undefined;
  const child: CommandSubprocess<CommandSpawnOptions> =
    broker && remoteOptions
      ? spawnBrokerCommand(
          broker,
          [invocation.command, ...invocation.args],
          commandOptions,
          remoteOptions,
        )
      : execa(invocation.command, invocation.args, commandOptions);
  recordChildProcessSpawn(invocation.command, child.nodeChildProcess);
  if (scope) {
    retainCommandProcess(scope, child);
  }
  return { child: child as CommandSubprocess<OptionsType>, invocation };
}

/** Spawn through the canonical argv, environment, and Windows safety boundary. */
export function spawnCommand<OptionsType extends SpawnCommandOptions = SpawnCommandOptions>(
  argv: string[],
  options: OptionsType = {} as OptionsType,
): CommandSubprocess<OptionsType> {
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
