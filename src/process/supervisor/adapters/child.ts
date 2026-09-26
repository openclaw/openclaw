import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import type { Writable } from "node:stream";
import {
  spawnWindowsJobChild,
  WindowsJobSetupError,
  type ManagedWindowsJob,
  type WindowsJobExtinction,
} from "../../../../scripts/lib/managed-windows-job.mts";
import { toErrorObject } from "../../../infra/errors.js";
import {
  resolveWindowsExecutablePath,
  resolveWindowsSpawnProgramCandidate,
} from "../../../plugin-sdk/windows-spawn.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  createAwaitedDecodedOutput,
  joinProcessCompletionAndOutput,
  onDecodedOutput,
} from "../../decoded-output.js";
import { killProcessTree, signalProcessTree } from "../../kill-tree.js";
import { prepareOomScoreAdjustedSpawn } from "../../linux-oom-score.js";
import { pipeProcessOutput } from "../../pipe-output.js";
import { scheduleAdoptedChildZombieReapAfterExit } from "../../scoped-child-reaper.js";
import { SpawnBrokerError } from "../../spawn-broker/protocol.js";
import { prepareSecretInputStdio, type SpawnStdioEntry } from "../../spawn-secret-input.js";
import { spawnWithFallback } from "../../spawn-utils.js";
import {
  buildWindowsCmdExeCommandLine,
  isWindowsBatchCommand,
  resolveTrustedWindowsCmdExe,
  resolveWindowsCommandShim,
} from "../../windows-command.js";
import { GRACEFUL_CANCEL_TIMEOUT_MS } from "../cancellation-policy.js";
import { createServiceChildRelayAdapter } from "../service-child-relay-host.js";
import type {
  AwaitedStdoutConsumer,
  ProcessAdapterConstruction,
  ProcessAdapterStartup,
  SpawnProcessAdapter,
  SpawnSecretInput,
} from "../types.js";
import { createManagedChildStdin } from "./child-stdin.js";
import { toStringEnv } from "./env.js";
import { createProcessAdapterEvents } from "./process-events.js";

const FORCE_KILL_WAIT_FALLBACK_MS = 4000;
const FORCED_WINDOWS_CLOSE_SETTLE_MS = 250;
const WINDOWS_PACKAGE_MANAGER_SHIMS = ["npm", "pnpm", "yarn", "npx"] as const;

function resolveChildInvocation(params: {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
}): {
  args: string[];
  command: string;
  windowsVerbatimArguments?: boolean;
} {
  const command = params.argv[0] ?? "";
  const candidate = resolveWindowsSpawnProgramCandidate({
    command,
    env: params.env,
    // npm shims invoke `node` from PATH; process.execPath may be a packaged OpenClaw executable.
    execPath:
      process.platform === "win32"
        ? resolveWindowsExecutablePath("node", params.env ?? process.env)
        : undefined,
  });
  const args = [...candidate.leadingArgv, ...params.argv.slice(1)];
  // Keep the historical package-manager fallback when PATH probing cannot see
  // its shim; every resolved wrapper takes the direct Node/exe path above.
  const resolvedCommand =
    candidate.resolution === "direct" && candidate.command === command
      ? resolveWindowsCommandShim({
          command,
          cmdCommands: WINDOWS_PACKAGE_MANAGER_SHIMS,
        })
      : candidate.command;
  if (!isWindowsBatchCommand(resolvedCommand)) {
    return {
      command: resolvedCommand,
      args,
      windowsVerbatimArguments: params.windowsVerbatimArguments,
    };
  }
  return {
    command: resolveTrustedWindowsCmdExe(),
    args: ["/d", "/s", "/c", buildWindowsCmdExeCommandLine(resolvedCommand, args)],
    windowsVerbatimArguments: true,
  };
}

type ChildAdapter = SpawnProcessAdapter<NodeJS.Signals | null> &
  Required<Pick<SpawnProcessAdapter<NodeJS.Signals | null>, "onExit" | "onError">>;
type WorkerChildAdapter = ChildAdapter & {
  closeStartGate?: () => void;
  openStartGate?: () => Promise<void>;
};
export type AwaitedStdoutChildAdapter = WorkerChildAdapter & AwaitedStdoutConsumer;

const WORKER_START_MESSAGE = { type: "openclaw-worker-start-v1" } as const;

type ChildAdapterInput = ProcessAdapterConstruction & {
  /** Retain a local tree owner independently of Gateway service markers. */
  ownProcessTree?: true;
  /** Preserve an owner-materialized Windows shell invocation without parsing it again. */
  windowsShell?: true;
  /** Own a separately signalable tree whose private IPC channel gates worker startup. */
  ownedWorker?: true;
  /** Preserve the supplied environment exactly by skipping environment-mutating spawn wrappers. */
  exactEnv?: true;
  onWorkerMessage?: (message: unknown) => void;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  argv0?: string;
  windowsVerbatimArguments?: boolean;
  input?: string;
  stdinMode?: "inherit" | "pipe-open" | "pipe-closed";
  secretInput?: SpawnSecretInput;
  stderrDestination?: Writable;
} & (
    | { argv: string[]; anchoredShellCommand?: never; stdoutConsumption?: "awaited" }
    | { argv?: never; anchoredShellCommand: string; stdoutConsumption?: never }
  );

export function createChildAdapter(
  params: ChildAdapterInput & { stdoutConsumption: "awaited" },
): Promise<ProcessAdapterStartup<AwaitedStdoutChildAdapter>>;
export function createChildAdapter(
  params: ChildAdapterInput,
): Promise<ProcessAdapterStartup<WorkerChildAdapter>>;
export async function createChildAdapter(
  params: ChildAdapterInput,
): Promise<ProcessAdapterStartup<WorkerChildAdapter>> {
  if (params.anchoredShellCommand !== undefined) {
    return await createServiceChildRelayAdapter({
      assertCurrent: params.assertCurrent,
      beforeSpawn: params.beforeSpawn,
      command: process.platform === "win32" ? params.anchoredShellCommand : "/bin/sh",
      args: process.platform === "win32" ? [] : ["-c", params.anchoredShellCommand],
      windowsShellCommand: process.platform === "win32" ? params.anchoredShellCommand : undefined,
      cwd: params.cwd,
      env: params.env,
      stdinMode: "pipe-closed",
      oomScoreWrapperSelected: false,
      abortSignal: params.abortSignal,
      onSpawnCleanup: params.onSpawnCleanup,
      stderrDestination: params.stderrDestination,
    });
  }

  const baseEnv = params.env ? toStringEnv(params.env) : undefined;
  const windowsShell = process.platform === "win32" && params.windowsShell === true;
  const invocation = windowsShell
    ? {
        command: params.argv[0]!,
        args: params.argv.slice(1),
        windowsVerbatimArguments: params.windowsVerbatimArguments,
      }
    : resolveChildInvocation({
        argv: params.argv,
        env: baseEnv,
        windowsVerbatimArguments: params.windowsVerbatimArguments,
      });
  const argv0 = invocation.command === params.argv[0] ? params.argv0 : undefined;
  const preparedSpawn = params.exactEnv
    ? { command: invocation.command, args: invocation.args, argv0, env: baseEnv, wrapped: false }
    : prepareOomScoreAdjustedSpawn(invocation.command, invocation.args, { env: baseEnv, argv0 });

  const stdinMode = params.stdinMode ?? (params.input !== undefined ? "pipe-closed" : "inherit");

  if (
    process.platform !== "win32" &&
    params.ownedWorker === undefined &&
    (params.ownProcessTree === true || process.env.OPENCLAW_SERVICE_MARKER?.trim())
  ) {
    return await createServiceChildRelayAdapter({
      assertCurrent: params.assertCurrent,
      beforeSpawn: params.beforeSpawn,
      command: preparedSpawn.command,
      args: preparedSpawn.args,
      argv0: preparedSpawn.argv0,
      cwd: params.cwd,
      env: preparedSpawn.env,
      stdinMode,
      input: params.input,
      secretInput: params.secretInput,
      oomScoreWrapperSelected: preparedSpawn.wrapped,
      abortSignal: params.abortSignal,
      onSpawnCleanup: params.onSpawnCleanup,
      stderrDestination: params.stderrDestination,
      stdoutConsumption: params.stdoutConsumption,
    });
  }

  // A detached POSIX child is still a descendant in the service cgroup/job, but
  // owns a process group that can be killed without touching the node host.
  const useDetached = process.platform !== "win32";

  const stdio: SpawnStdioEntry[] = [stdinMode === "inherit" ? "inherit" : "pipe", "pipe", "pipe"];
  using secretDelivery = prepareSecretInputStdio(stdio, params.secretInput);
  if (params.ownedWorker !== undefined) {
    stdio.push("ipc");
  }

  const options: SpawnOptions = {
    cwd: params.cwd,
    env: preparedSpawn.env,
    argv0: preparedSpawn.argv0,
    stdio,
    detached: useDetached,
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    ...(windowsShell ? { shell: true } : {}),
  };

  const assertCurrent = () => {
    params.assertCurrent?.();
    if (params.abortSignal?.aborted) {
      throw new Error("child construction aborted");
    }
  };
  let windowsJob: ManagedWindowsJob | undefined;
  let windowsCleanup: Promise<WindowsJobExtinction> | undefined;
  const launchGate = createDeferredCore();
  let windowsFallback: WindowsJobExtinction = { status: "uncertain", reason: "job-unavailable" };
  let tryWindowsJob = true;
  const spawnChild = () =>
    spawnWithFallback({
      ...(process.platform === "win32"
        ? {
            spawnImpl: (command, args, spawnOptions) => {
              if (!tryWindowsJob) {
                return spawn(command, args, spawnOptions);
              }
              const owned = spawnWindowsJobChild(
                command,
                args,
                { ...spawnOptions, signal: params.abortSignal },
                async (launch) => {
                  await launchGate.promise;
                  assertCurrent();
                  params.beforeSpawn?.();
                  launch();
                },
              );
              if (!owned) {
                return spawn(command, args, spawnOptions);
              }
              windowsJob = owned.job;
              windowsCleanup = owned.job.certify();
              void windowsCleanup.catch(() => {});
              params.onSpawnCleanup?.(windowsCleanup);
              return owned.child;
            },
          }
        : {}),
      assertCurrent: () => {
        assertCurrent();
        params.beforeSpawn?.();
      },
      argv: [preparedSpawn.command, ...preparedSpawn.args],
      options,
      fallbacks: useDetached && params.ownedWorker === undefined ? [{ detached: false }] : [],
    });

  let spawned: Awaited<ReturnType<typeof spawnChild>>;
  try {
    spawned = await spawnChild();
    if (windowsJob) {
      await windowsJob.admission;
    }
  } catch (error) {
    if (!(error instanceof WindowsJobSetupError)) {
      throw error;
    }
    // No command has been admitted. Retire the launcher before the ordinary spawn.
    await windowsJob?.certify();
    windowsFallback = { status: "uncertain", reason: error.reason, cause: error.cause };
    windowsJob = undefined;
    windowsCleanup = undefined;
    tryWindowsJob = false;
    spawned = await spawnChild();
  }

  const child = spawned.child as ChildProcessWithoutNullStreams;
  const events = createProcessAdapterEvents();
  if (params.onWorkerMessage) {
    child.on("message", (message) => {
      try {
        if (!windowsJob?.isControlMessage(message)) {
          params.onWorkerMessage?.(message);
        }
      } catch {
        // Worker diagnostics cannot change child supervision.
      }
    });
  }
  const disconnectWorkerIpc = () => {
    if (!child.connected) {
      return;
    }
    try {
      child.disconnect();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ERR_IPC_DISCONNECTED") {
        throw error;
      }
    }
  };
  // Pipe errors can arrive before output subscribers attach. Close remains
  // responsible for decoder flush and Windows drain completion.
  child.stdout.on("error", (error) => events.emitError(error, "stdout"));
  child.stderr.on("error", (error) => events.emitError(error, "stderr"));
  child.stdin?.on("error", (error) => events.emitError(error, "stdin"));
  const childStdin = spawned.child.stdin;
  const stdin = createManagedChildStdin(childStdin);
  const outputUnsubscribers: Array<() => void> = [];
  const awaitedStdout =
    params.stdoutConsumption === "awaited"
      ? createAwaitedDecodedOutput(child.stdout, () => {
          if (!hardKillRequested) {
            kill("SIGKILL");
          }
        })
      : undefined;
  if (params.stderrDestination) {
    outputUnsubscribers.push(
      pipeProcessOutput(child.stderr, params.stderrDestination, (error) =>
        events.emitError(error, "stderr"),
      ),
    );
  }
  const onStdout: ChildAdapter["onStdout"] = (listener, onRaw) => {
    if (awaitedStdout) {
      throw new Error("Process stdout requires its awaited consumer");
    }
    outputUnsubscribers.push(onDecodedOutput(child.stdout, listener, onRaw));
  };

  const onStderr: ChildAdapter["onStderr"] = (listener, onRaw) => {
    outputUnsubscribers.push(onDecodedOutput(child.stderr, listener, onRaw));
  };

  const completion = createDeferredCore<{ code: number | null; signal: NodeJS.Signals | null }>();
  const cleanup = createDeferredCore();
  // Worker errors can precede wait(), including while secret delivery is still pending.
  void completion.promise.catch(() => {});
  let waitSettled = false;
  let processClosed = false;
  let forceKillWaitFallbackTimer: NodeJS.Timeout | null = null;
  let forcedWindowsCloseTimer: NodeJS.Timeout | null = null;
  let hardKillRequested = false;
  let treeSignaling: Promise<void> | undefined;
  const cleanupOutcome = Promise.allSettled([cleanup.promise]).then((outcomes) => {
    clearForceKillWaitFallback();
    return outcomes;
  });
  let windowsTreeKillCompleted = false;
  let childExitState: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let childCloseState: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let stdoutDrained = child.stdout == null;
  let stderrDrained = child.stderr == null;
  let workerIpcDisconnected = false;
  let openWorkerStdio = 0;

  const clearForceKillWaitFallback = () => {
    if (!forceKillWaitFallbackTimer) {
      return;
    }
    clearTimeout(forceKillWaitFallbackTimer);
    forceKillWaitFallbackTimer = null;
  };

  const clearForcedWindowsCloseTimer = () => {
    if (!forcedWindowsCloseTimer) {
      return;
    }
    clearTimeout(forcedWindowsCloseTimer);
    forcedWindowsCloseTimer = null;
  };

  const settleWait = (value: { code: number | null; signal: NodeJS.Signals | null }) => {
    if (waitSettled) {
      return;
    }
    waitSettled = true;
    clearForcedWindowsCloseTimer();
    completion.resolve(value);
  };

  const settleObservedClose = (value: { code: number | null; signal: NodeJS.Signals | null }) => {
    processClosed = true;
    // Native close fences new signals; join all already-admitted deliveries before success.
    if (treeSignaling) {
      treeSignaling = treeSignaling.then(() => cleanup.resolve(), cleanup.reject);
    } else {
      cleanup.resolve();
    }
    settleWait(value);
  };

  const rejectPendingWait = (error: unknown) => {
    if (waitSettled) {
      return;
    }
    waitSettled = true;
    clearForcedWindowsCloseTimer();
    completion.reject(error);
  };

  const scheduleForceKillWaitFallback = (signal: NodeJS.Signals) => {
    // Repeated hard cancellation must not postpone the owner's terminal result.
    if (forceKillWaitFallbackTimer || waitSettled) {
      return;
    }
    // Some Windows child processes never emit `close` after a hard kill.
    forceKillWaitFallbackTimer = setTimeout(() => {
      cleanup.reject(new Error("child cleanup could not be confirmed before the kill deadline"));
      awaitedStdout?.close();
      settleWait({ code: null, signal });
    }, FORCE_KILL_WAIT_FALLBACK_MS);
    forceKillWaitFallbackTimer.unref?.();
  };

  const resolveObservedExitState = (fallback: {
    code: number | null;
    signal: NodeJS.Signals | null;
  }) => {
    if (childExitState != null) {
      return childExitState;
    }
    return {
      code: child.exitCode ?? fallback.code,
      signal: child.signalCode ?? fallback.signal,
    };
  };

  const scheduleForcedWindowsCloseSettlement = () => {
    if (
      process.platform !== "win32" ||
      !hardKillRequested ||
      !windowsTreeKillCompleted ||
      childExitState == null ||
      forcedWindowsCloseTimer
    ) {
      return;
    }
    const exitState = childExitState;
    forcedWindowsCloseTimer = setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      settleWait(resolveObservedExitState(exitState));
    }, FORCED_WINDOWS_CLOSE_SETTLE_MS);
    forcedWindowsCloseTimer.unref?.();
  };

  const isWindowsHardKillSettlementBlocked = () =>
    process.platform === "win32" && hardKillRequested && !windowsTreeKillCompleted;

  const maybeSettleAfterExit = () => {
    if (
      (process.platform !== "win32" && (!workerIpcDisconnected || openWorkerStdio > 0)) ||
      isWindowsHardKillSettlementBlocked() ||
      childExitState == null ||
      !stdoutDrained ||
      !stderrDrained
    ) {
      return;
    }
    settleObservedClose(resolveObservedExitState(childExitState));
  };

  if (params.ownedWorker) {
    // Parent-initiated IPC disconnect can suppress Node's child close event.
    // Preserve its exit-and-closed-pipes boundary, including secret descriptors.
    child.once("disconnect", () => {
      workerIpcDisconnected = true;
      maybeSettleAfterExit();
    });
    for (const stream of child.stdio.slice(1)) {
      if (!stream || stream.closed) {
        continue;
      }
      openWorkerStdio += 1;
      stream.once("close", () => {
        openWorkerStdio -= 1;
        maybeSettleAfterExit();
      });
    }
  }

  const markStdoutDrained = () => {
    stdoutDrained = true;
    maybeSettleAfterExit();
  };
  const markStderrDrained = () => {
    stderrDrained = true;
    maybeSettleAfterExit();
  };
  child.stdout?.once("end", markStdoutDrained);
  child.stdout?.once("close", markStdoutDrained);
  child.stderr?.once("end", markStderrDrained);
  child.stderr?.once("close", markStderrDrained);

  // Worker IPC failures close authority; ordinary post-spawn errors are nonterminal.
  child.on("error", (error) => {
    events.emitError(error, "process");
    if (params.ownedWorker || error instanceof SpawnBrokerError) {
      rejectPendingWait(error);
    }
  });
  child.once("exit", (code, signal) => {
    childExitState = { code, signal };
    events.emitExit(code, signal);
    scheduleForcedWindowsCloseSettlement();
    maybeSettleAfterExit();
  });
  child.once("close", (code, signal) => {
    childCloseState = { code, signal };
    childExitState ??= childCloseState;
    if (isWindowsHardKillSettlementBlocked()) {
      return;
    }
    settleObservedClose(resolveObservedExitState(childCloseState));
  });

  const wait = async () => {
    if (!awaitedStdout) {
      return await completion.promise;
    }
    return await joinProcessCompletionAndOutput(completion.promise, awaitedStdout.drain());
  };

  // A no-detach fallback shares the Gateway's group and must never group-kill it.
  const childIsDetached = useDetached && !spawned.usedFallback;
  const attachedLinuxFallback = process.platform === "linux" && !childIsDetached;
  let attachedTerminationStarted = false;
  let attachedTermination: ReturnType<typeof killProcessTree>;
  const scheduleAdoptedReapForChild = () => {
    // Reap after Node exit/adoption — not at signal time — and never waitpid
    // the tracked root (libuv owns that ChildProcess).
    scheduleAdoptedChildZombieReapAfterExit(child, childIsDetached);
  };
  const signalProcessTreeForChild = (pid: number, signal: "SIGTERM" | "SIGKILL") => {
    if (attachedLinuxFallback) {
      if (attachedTerminationStarted) {
        if (signal === "SIGKILL") {
          attachedTermination?.force();
        }
      } else if (!childExitState) {
        // Retain one identity-bound snapshot across root settlement. Its timer
        // must survive disposal when the supervisor clears its own grace timer.
        attachedTerminationStarted = true;
        attachedTermination = killProcessTree(pid, {
          detached: false,
          graceMs: GRACEFUL_CANCEL_TIMEOUT_MS,
          force: signal === "SIGKILL",
        });
      }
      return;
    }
    signalProcessTree(pid, signal, { detached: childIsDetached });
    scheduleAdoptedReapForChild();
  };
  const signalProcessTreeForChildAndWait = (pid: number, signal: "SIGTERM" | "SIGKILL") =>
    new Promise<void>((resolve) => {
      if (attachedLinuxFallback) {
        signalProcessTreeForChild(pid, signal);
        resolve();
        return;
      }
      signalProcessTree(pid, signal, {
        detached: childIsDetached,
        onComplete: () => {
          scheduleAdoptedReapForChild();
          resolve();
        },
      });
    });
  const kill = (signal?: NodeJS.Signals) => {
    if (windowsJob) {
      try {
        windowsJob.stop();
      } catch (error) {
        cleanup.reject(error);
        rejectPendingWait(error);
      }
      scheduleForceKillWaitFallback(signal ?? "SIGKILL");
      return;
    }
    // A delayed private-input failure must not signal a PID whose child has closed.
    if (processClosed) {
      if (signal === undefined || signal === "SIGKILL") {
        attachedTermination?.force();
      }
      return;
    }
    const pid = child.pid ?? undefined;
    if (signal === undefined || signal === "SIGKILL") {
      hardKillRequested = true;
      scheduleForcedWindowsCloseSettlement();
      if (pid) {
        // Let the tree owner traverse the live root before directly killing it.
        // On Windows, killing the root first can make `taskkill /T` lose the
        // descendant relationship. (#71662)
        const previousSignal = treeSignaling;
        treeSignaling = (async () => {
          try {
            await signalProcessTreeForChildAndWait(pid, "SIGKILL");
            try {
              child.kill("SIGKILL");
            } catch {
              // The native close observation still owns confirmation.
            }
            windowsTreeKillCompleted = true;
            if (childCloseState) {
              settleObservedClose(resolveObservedExitState(childCloseState));
              return;
            }
            maybeSettleAfterExit();
            scheduleForcedWindowsCloseSettlement();
          } catch (error) {
            cleanup.reject(error);
            rejectPendingWait(error);
          } finally {
            await previousSignal;
          }
        })();
      } else {
        windowsTreeKillCompleted = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore kill errors
        }
      }
      scheduleForceKillWaitFallback("SIGKILL");
      return;
    }
    if (signal === "SIGTERM" && pid) {
      signalProcessTreeForChild(pid, "SIGTERM");
      return;
    }
    try {
      child.kill(signal);
    } catch {
      // ignore kill errors for non-kill signals
    }
  };

  const dispose = () => {
    awaitedStdout?.close();
    clearForcedWindowsCloseTimer();
    if (params.ownedWorker !== undefined) {
      disconnectWorkerIpc();
    }
    for (const unsubscribe of outputUnsubscribers.splice(0)) {
      unsubscribe();
    }
    // Error handling and Node's child-close bookkeeping must remain attached during destroy.
    child.stdout.destroy();
    child.stderr.destroy();
    if (!windowsJob) {
      child.removeAllListeners();
    }
    events.clear();
  };

  const closeStartGate = params.ownedWorker ? disconnectWorkerIpc : undefined;

  let startGateOpened = false;
  const openStartGate = params.ownedWorker
    ? async () => {
        if (startGateOpened) {
          return;
        }
        startGateOpened = true;
        await new Promise<void>((resolve, reject) => {
          if (!child.connected) {
            reject(new Error("worker lifecycle IPC channel closed before startup"));
            return;
          }
          try {
            child.send(WORKER_START_MESSAGE, (error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          } catch (error) {
            reject(toErrorObject(error, "worker lifecycle IPC send failed"));
          }
        });
      }
    : undefined;

  const adapter: WorkerChildAdapter = {
    get pid() {
      return windowsJob?.commandPid ?? child.pid;
    },
    stdin,
    oomScoreWrapperSelected: preparedSpawn.wrapped,
    supportsRawOutput: true,
    onStdout,
    ...(awaitedStdout ? { consumeStdout: awaitedStdout.consume } : {}),
    onStderr,
    onExit: events.onExit,
    onError: events.onError,
    wait,
    ...(process.platform === "win32" && {
      waitForExtinction: () => windowsCleanup ?? cleanup.promise.then(() => windowsFallback),
    }),
    kill,
    dispose,
    closeStartGate,
    openStartGate,
  };
  if (!windowsCleanup) {
    params.onSpawnCleanup?.(adapter.waitForExtinction?.() ?? cleanup.promise);
  }
  launchGate.resolve();
  const ready = (async () => {
    try {
      if (windowsJob) {
        await windowsJob.ready;
      }
      // Construction may outlive admission; publish cleanup before any private input.
      assertCurrent();
      if (params.ownedWorker !== undefined && (!child.connected || !child.channel)) {
        throw new Error("worker lifecycle IPC channel was not created");
      }
      if (params.input !== undefined) {
        childStdin?.write(params.input);
        stdin?.end();
      } else if (stdinMode === "pipe-closed") {
        stdin?.end();
      }
      if (params.secretInput) {
        assertCurrent();
        // deliverTo transfers its pipe synchronously; readiness retains the writer.
        await secretDelivery?.deliverTo(child, { abortSignal: params.abortSignal });
      }
    } catch (error) {
      kill("SIGKILL");
      try {
        const [outcome] = await cleanupOutcome;
        if (outcome.status === "rejected") {
          throw outcome.reason;
        }
      } finally {
        dispose();
      }
      throw error;
    }
  })();
  void ready.catch(() => {});
  return { adapter, ready };
}
