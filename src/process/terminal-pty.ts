import path from "node:path";
import { resolveEnvironmentValue } from "../infra/process-env.js";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsExecutablePath,
  resolveWindowsSpawnProgram,
} from "../plugin-sdk/windows-spawn.js";
import { signalPtySessionTree } from "./kill-tree.js";
import { resolvePtyTerminalName, setPtyTerminalName } from "./pty-terminal-name.js";
import type { SpawnInitiation } from "./spawn-initiation.js";
import {
  buildWindowsCmdExeCommandLine,
  isWindowsBatchCommand,
  resolveTrustedWindowsCmdExe,
} from "./windows-command.js";

/** Live PTY handle shared by gateway terminals and node-host commands. */
export type TerminalPtySubscription = { dispose(): void };

export type TerminalPtyHandle = {
  pid: number;
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  onData(listener: (chunk: string) => void): TerminalPtySubscription | void;
  onExit(
    listener: (event: { exitCode: number; signal?: number }) => void,
  ): TerminalPtySubscription | void;
  kill(signal?: string): void;
};

function resolveTerminalNodeExecutable(env: NodeJS.ProcessEnv): string {
  // Packaged OpenClaw/Bun hosts cannot interpret npm's JavaScript entrypoint.
  // Use the running binary only when it is Node; otherwise require PATH node.exe.
  const candidate =
    path.win32.basename(process.execPath).toLowerCase() === "node.exe"
      ? process.execPath
      : resolveWindowsExecutablePath("node", env);
  if (path.win32.basename(candidate).toLowerCase() === "node.exe") {
    return candidate;
  }
  throw new Error(
    "A Node executable is required to launch this Windows npm wrapper; add node.exe to PATH.",
  );
}

function resolveTerminalPtyInvocation(params: {
  file: string;
  args: string[];
  platform?: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}): { file: string; args: string[] | string } {
  const platform = params.platform ?? process.platform;
  if (!isWindowsBatchCommand(params.file, platform)) {
    return { file: params.file, args: params.args };
  }
  const program = resolveWindowsSpawnProgram({
    command: params.file,
    platform,
    env: params.env,
    execPath: process.execPath,
    allowShellFallback: true,
  });
  if (program.resolution !== "shell-fallback") {
    const invocation = materializeWindowsSpawnProgram(
      program.resolution === "node-entrypoint"
        ? { ...program, command: resolveTerminalNodeExecutable(params.env) }
        : program,
      params.args,
    );
    return { file: invocation.command, args: invocation.argv };
  }
  return {
    file:
      resolveEnvironmentValue(params.env, "COMSPEC")?.trim() ||
      resolveTrustedWindowsCmdExe(platform),
    // node-pty preserves string tails verbatim; arrays would escape the prepared cmd quotes again.
    args: `/d /s /c ${buildWindowsCmdExeCommandLine(params.file, params.args)}`,
  };
}

export type TerminalPtySpawnParams = {
  file: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  name?: string;
  cols: number;
  rows: number;
};

type BunTerminalCapability = { Terminal?: { prototype?: { pause?: unknown } } };

function bunTerminalHasFlowControl(): boolean {
  // SAFETY: Bun is an optional runtime global; only the pause capability is inspected.
  const bun = (globalThis as typeof globalThis & { Bun?: BunTerminalCapability }).Bun;
  return typeof bun?.Terminal?.prototype?.pause === "function";
}

export async function spawnTerminalPty(
  params: TerminalPtySpawnParams,
  lifecycle?: {
    abortSignal?: AbortSignal;
    assertCurrent?: () => void;
    initiateSpawn?: SpawnInitiation;
  },
): Promise<TerminalPtyHandle> {
  const assertCurrent = () => {
    lifecycle?.assertCurrent?.();
    if (lifecycle?.abortSignal?.aborted) {
      throw new Error("PTY construction aborted");
    }
  };
  if (process.versions.bun && process.platform !== "win32" && !bunTerminalHasFlowControl()) {
    // Stock Bun lacks read backpressure; the fork shipping pause also fixes macOS wait4 deadlocks.
    const { spawnNodeTerminalPty } = await import("./terminal-pty-node.js");
    assertCurrent();
    return await spawnNodeTerminalPty(params, assertCurrent, lifecycle?.initiateSpawn);
  }
  const launch = await prepareTerminalPty(params);
  assertCurrent();
  return lifecycle?.initiateSpawn ? lifecycle.initiateSpawn(launch) : launch();
}

/** Load the native backend before a remote host grants the final synchronous launch. */
export async function prepareTerminalPty(
  params: TerminalPtySpawnParams,
): Promise<() => TerminalPtyHandle> {
  const env = params.env ? { ...params.env } : undefined;
  // Ambient TERM=dumb describes the gateway/node host, not this real PTY.
  // Passing it through makes interactive CLIs refuse to start in the web terminal.
  const terminalName = resolvePtyTerminalName(
    params.name ?? resolveEnvironmentValue(env ?? process.env, "TERM", process.platform),
  );
  if (env) {
    setPtyTerminalName({ env, name: terminalName, platform: process.platform });
  }
  if (process.versions.bun && process.platform !== "win32") {
    // Bun closes node-pty's nonblocking tty.ReadStream on EAGAIN; use its native PTY.
    const { spawnBunTerminalPty } = await import("./terminal-pty-bun.js");
    const bunEnv = env ?? inheritedTerminalEnv(terminalName);
    // node-pty always exports the child's working directory as PWD.
    bunEnv.PWD = params.cwd ?? process.cwd();
    return () => spawnBunTerminalPty({ ...params, env: bunEnv, name: terminalName });
  }
  const { spawn } = await import("@lydell/node-pty");
  const invocation = resolveTerminalPtyInvocation({
    file: params.file,
    args: params.args,
    env: env ?? process.env,
  });
  return () => {
    const pty = spawn(invocation.file, invocation.args, {
      name: terminalName,
      cols: params.cols,
      rows: params.rows,
      cwd: params.cwd,
      env,
    });
    return {
      get pid() {
        return pty.pid;
      },
      // SAFETY: node-pty accepts Buffer input at runtime although its declaration exposes string.
      write: (data) => pty.write(data as string),
      resize: (cols, rows) => pty.resize(cols, rows),
      pause: () => pty.pause(),
      resume: () => pty.resume(),
      onData: (listener) => pty.onData(listener),
      onExit: (listener) => pty.onExit(listener),
      kill: (signal) =>
        signalTerminalPtyTree(pty.pid, signal, (sig) =>
          process.platform === "win32" ? pty.kill() : pty.kill(sig),
        ),
    } satisfies TerminalPtyHandle;
  };
}

// node-pty inherits process.env without host terminal-multiplexer state.
const HOST_TERMINAL_ENV_KEYS = new Set([
  "TMUX",
  "TMUX_PANE",
  "STY",
  "WINDOW",
  "WINDOWID",
  "TERMCAP",
  "COLUMNS",
  "LINES",
]);

function inheritedTerminalEnv(terminalName: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !HOST_TERMINAL_ENV_KEYS.has(key)) {
      env[key] = value;
    }
  }
  env.TERM = terminalName;
  return env;
}

// A long-running child of the interactive shell must not survive terminal
// close. Signal the process tree, matching the process supervisor contract.
export function signalTerminalPtyTree(
  pid: number,
  signal: string | undefined,
  signalDirect: (signal: NodeJS.Signals) => void,
): void {
  const sig = (signal ?? "SIGKILL") as NodeJS.Signals;
  try {
    if ((sig === "SIGKILL" || sig === "SIGTERM") && pid > 0) {
      // The PTY child leads a new session/process group; retain descendant
      // cleanup after the shell exits and only its group remains.
      signalPtySessionTree(pid, sig);
    } else {
      signalDirect(sig);
    }
  } catch {
    // Process may already be gone; teardown is best-effort.
  }
}
