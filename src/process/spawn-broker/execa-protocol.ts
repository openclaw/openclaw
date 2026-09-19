import type { Options } from "execa";
import {
  decodeExecaMessage,
  encodeExecaMessage,
  type EncodedExecaMessage,
  type ExecaMessageOutput,
} from "./execa-message.js";

export type BrokerOutputOption = "pipe" | "ignore" | "inherit" | { file: string };

/** The serializable execa options used by the command transport. */
export type BrokerExecaOptions = Pick<
  Options,
  | "buffer"
  | "detached"
  | "encoding"
  | "extendEnv"
  | "forceKillAfterDelay"
  | "killDescendants"
  | "killSignal"
  | "maxBuffer"
  | "reject"
  | "stripFinalNewline"
  | "timeout"
  | "windowsHide"
  | "windowsVerbatimArguments"
> & {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Uint8Array;
  shell?: false;
  stdin?: "pipe" | "ignore" | "inherit";
  stdout?: BrokerOutputOption;
  stderr?: BrokerOutputOption;
  stdio?:
    | "pipe"
    | "ignore"
    | "inherit"
    | readonly ["pipe" | "ignore" | "inherit", BrokerOutputOption, BrokerOutputOption];
};

export type BrokerExecaError = EncodedExecaMessage & {
  name: string;
  code?: string;
  cause?: BrokerExecaError;
};

export type BrokerExecaResult = ExecaMessageOutput & {
  exitCode?: number;
  signal?: NodeJS.Signals;
  failed: boolean;
  timedOut: boolean;
  isCanceled: boolean;
  isGracefullyCanceled: boolean;
  isMaxBuffer: boolean;
  isTerminated: boolean;
  isForcefullyTerminated: boolean;
  shortMessage?: string;
  originalMessage?: string;
  code?: string;
  command: string;
  escapedCommand: string;
  cwd: string;
  durationMs: number;
  signalDescription?: string;
  error?: BrokerExecaError;
};

export function serializeExecaError(
  error: Error,
  output: ExecaMessageOutput = {},
): BrokerExecaError {
  return {
    name: error.name,
    ...encodeExecaMessage(error.message, output),
    ...("code" in error && typeof error.code === "string" ? { code: error.code } : {}),
    ...(error.cause instanceof Error ? { cause: serializeExecaError(error.cause) } : {}),
  };
}

function restoreError(error: BrokerExecaError, output: ExecaMessageOutput): Error {
  const restored = new Error(decodeExecaMessage(error, output), {
    cause: error.cause ? restoreError(error.cause, output) : undefined,
  });
  return Object.assign(restored, { name: error.name, code: error.code });
}

/** Failed reject:false results are still Errors, as they are with local execa. */
export function restoreExecaResult(result: BrokerExecaResult) {
  const { error, ...received } = result;
  const properties = {
    ...received,
    stdout: received.stdout,
    stderr: received.stderr,
    shortMessage: received.shortMessage,
    code: received.code,
  };
  if (error) {
    const restored = restoreError(error, properties);
    return Object.assign(restored, properties, { cause: restored.cause });
  }
  return { ...properties, cause: undefined };
}
