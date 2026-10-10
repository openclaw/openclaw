import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { Options } from "execa";

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

type OutputStream = "stdout" | "stderr";
type Option<OptionsType, Key extends PropertyKey> = Key extends keyof OptionsType
  ? OptionsType[Key]
  : undefined;
type DefaultOption<Value, Default> = Value extends undefined ? Default : Value;
type StdioOutput<Stdio, Stream extends OutputStream> = Stdio extends readonly unknown[]
  ? Stdio[Stream extends "stdout" ? 1 : 2]
  : Stdio;
type EncodedOutput<Encoding> = Encoding extends "buffer" ? Uint8Array : string;
type CapturedOutput<Destination, Output> = Destination extends
  | "ignore"
  | "inherit"
  | number
  | Readable
  | Writable
  ? undefined
  : Output;
type BufferedOutput<BufferOption, Stream extends OutputStream, Output> = BufferOption extends false
  ? undefined
  : BufferOption extends Record<Stream, false>
    ? undefined
    : Output;

type CommandOutput<OptionsType extends Options, Stream extends OutputStream> = BufferedOutput<
  Option<OptionsType, "buffer">,
  Stream,
  CapturedOutput<
    DefaultOption<Option<OptionsType, Stream>, StdioOutput<Option<OptionsType, "stdio">, Stream>>,
    EncodedOutput<Option<OptionsType, "encoding">>
  >
>;

/** The result fields consumed by OpenClaw's command callers, independent of execa helpers. */
type CommandResult<OptionsType extends Options = Options> = {
  stdout: CommandOutput<OptionsType, "stdout">;
  stderr: CommandOutput<OptionsType, "stderr">;
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
