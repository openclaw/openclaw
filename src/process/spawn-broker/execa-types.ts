import type { ChildProcess } from "node:child_process";
import type { Options, Result } from "execa";

type NativeInput = Extract<Options["stdin"], string | number>;
type NativeOutput = Extract<Options["stdout"], string | number> | { file: string };

/** Command callers use byte/text pipes, native descriptors, or file destinations. */
export type CommandSpawnOptions = Pick<
  Options,
  | "buffer"
  | "cancelSignal"
  | "cleanup"
  | "cwd"
  | "detached"
  | "encoding"
  | "env"
  | "extendEnv"
  | "forceKillAfterDelay"
  | "ipc"
  | "killDescendants"
  | "killSignal"
  | "maxBuffer"
  | "reject"
  | "shell"
  | "stripFinalNewline"
  | "timeout"
  | "windowsHide"
  | "windowsVerbatimArguments"
> & {
  input?: string | Uint8Array;
  stdin?: NativeInput;
  stdout?: NativeOutput;
  stderr?: NativeOutput;
  stdio?: "pipe" | "ignore" | "inherit" | readonly [NativeInput, NativeOutput, NativeOutput];
};

/** The result fields consumed by OpenClaw's command callers, independent of execa helpers. */
type CommandResult<OptionsType extends Options = Options> = Pick<
  Result<OptionsType>,
  "stdout" | "stderr"
> & {
  exitCode?: number;
  signal?: NodeJS.Signals;
  failed: boolean;
  timedOut: boolean;
  isCanceled: boolean;
  isMaxBuffer: boolean;
  isTerminated: boolean;
  isForcefullyTerminated: boolean;
  shortMessage?: string;
  code?: string;
  cause?: unknown;
};

export type CommandSubprocess<OptionsType extends Options = Options> = Promise<
  CommandResult<OptionsType>
> &
  Pick<ChildProcess, "pid" | "stdin" | "stdout" | "stderr"> & {
    nodeChildProcess: ChildProcess;
    kill: (signal?: NodeJS.Signals | number) => boolean;
  };
