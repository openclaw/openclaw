import { stripVTControlCharacters } from "node:util";
import type { CommandStdinFileSource } from "../command-stdin-file.js";
import type { CommandSpawnOptions } from "./execa-types.js";

type OutputStream = "stdout" | "stderr";
type ExecaMessageOutput = Partial<Record<OutputStream, string | Uint8Array>>;
type EncodedExecaMessage = { message: string; messageOutputs?: OutputStream[] };

const decoder = new TextDecoder();
const commonEscapes = new Map([
  [" ", " "],
  ["\n", "\n"],
  ["\b", "\\b"],
  ["\f", "\\f"],
  ["\r", "\\r"],
  ["\t", "\\t"],
]);

// Execa 10's output rendering (lib/return/message.js and lib/arguments/escape.js).
// This is only a compression candidate: encoding verifies it against execa's actual message.
function renderOutput(output: string | Uint8Array | undefined): string {
  let text = typeof output === "string" ? output : decoder.decode(output);
  if (text.endsWith("\n")) {
    text = text.slice(0, text.endsWith("\r\n") ? -2 : -1);
  }
  return stripVTControlCharacters(text).replace(/[\p{Separator}\p{Other}]/gu, (character) => {
    const common = commonEscapes.get(character);
    if (common !== undefined) {
      return common;
    }
    const codepoint = character.codePointAt(0)!;
    const hex = codepoint.toString(16);
    return codepoint <= 0xffff ? `\\u${hex.padStart(4, "0")}` : `\\U${hex}`;
  });
}

/** Keep the authoritative prefix and replace only exactly matching output suffixes. */
function encodeExecaMessage(message: string, output: ExecaMessageOutput): EncodedExecaMessage {
  const outputs: OutputStream[] = [];
  let end = message.length;
  for (const stream of ["stdout", "stderr"] as const) {
    const rendered = renderOutput(output[stream]);
    if (!rendered) {
      continue;
    }
    const start = end - rendered.length;
    if (
      start < 2 ||
      !message.endsWith(rendered, end) ||
      message.slice(start - 2, start) !== "\n\n"
    ) {
      return { message };
    }
    outputs.unshift(stream);
    end = start - 2;
  }
  return outputs.length > 0
    ? { message: message.slice(0, end), messageOutputs: outputs }
    : { message };
}

function decodeExecaMessage(encoded: EncodedExecaMessage, output: ExecaMessageOutput): string {
  return encoded.messageOutputs
    ? [
        encoded.message,
        ...encoded.messageOutputs.map((stream) => renderOutput(output[stream])),
      ].join("\n\n")
    : encoded.message;
}

export type BrokerOutputOption = "pipe" | "ignore" | "inherit" | { file: string };

function isBrokerOutputOption(value: unknown): value is BrokerOutputOption | undefined {
  return (
    value === undefined ||
    value === "pipe" ||
    value === "ignore" ||
    value === "inherit" ||
    (typeof value === "object" &&
      value !== null &&
      "file" in value &&
      typeof value.file === "string" &&
      Object.keys(value).length === 1)
  );
}

export type BrokerExecaOptions = Omit<
  CommandSpawnOptions,
  | "cancelSignal"
  | "cleanup"
  | "ipc"
  | "cwd"
  | "env"
  | "shell"
  | "stdin"
  | "stdout"
  | "stderr"
  | "stdio"
> & {
  executionDeadlineMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  shell?: false;
  stdin?: "pipe" | "ignore" | "inherit";
  stdinFile?: CommandStdinFileSource;
  stdout?: BrokerOutputOption;
  stderr?: BrokerOutputOption;
  stdio?:
    | "pipe"
    | "ignore"
    | "inherit"
    | readonly ["pipe" | "ignore" | "inherit", BrokerOutputOption, BrokerOutputOption];
};

/** Unsupported native descriptors and independent-lifetime commands remain explicit local paths. */
export function brokerExecaOptions(
  options: CommandSpawnOptions,
): BrokerExecaOptions | "ipc" | "independent" | "descriptor" | "inherit" {
  if (options.ipc || options.cleanup === false || typeof options.stdin === "number") {
    return options.ipc ? "ipc" : options.cleanup === false ? "independent" : "descriptor";
  }
  if (
    options.stdout === "inherit" ||
    options.stderr === "inherit" ||
    options.stdio === "inherit" ||
    typeof options.stdout === "number" ||
    typeof options.stderr === "number"
  ) {
    return typeof options.stdout === "number" || typeof options.stderr === "number"
      ? "descriptor"
      : "inherit";
  }
  const nativeStdio = Array.isArray(options.stdio)
    ? options.stdio.find(
        (entry, fd) => typeof entry === "number" || (fd > 0 && entry === "inherit"),
      )
    : undefined;
  if (nativeStdio !== undefined) {
    return typeof nativeStdio === "number" ? "descriptor" : "inherit";
  }
  if (
    (options.cwd !== undefined && typeof options.cwd !== "string") ||
    (options.input !== undefined &&
      typeof options.input !== "string" &&
      !(options.input instanceof Uint8Array)) ||
    (options.stdin !== undefined &&
      options.stdin !== "pipe" &&
      options.stdin !== "ignore" &&
      options.stdin !== "inherit") ||
    !isBrokerOutputOption(options.stdout) ||
    !isBrokerOutputOption(options.stderr) ||
    (options.shell !== undefined && options.shell !== false)
  ) {
    throw new TypeError("Unsupported spawn broker execa stream or invocation options");
  }
  if (
    Array.isArray(options.stdio) &&
    (options.stdio.length !== 3 ||
      !["pipe", "ignore", "inherit"].includes(String(options.stdio[0])) ||
      !isBrokerOutputOption(options.stdio[1]) ||
      !isBrokerOutputOption(options.stdio[2]))
  ) {
    throw new TypeError("Unsupported spawn broker execa stdio");
  }
  const { cancelSignal: _cancelSignal, ...serializable } = options;
  // SAFETY: The allowed options were checked above, excluding streams, URLs, IPC and native descriptors.
  return serializable as BrokerExecaOptions;
}

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

/** Failed admission has no command or native process metadata. */
export function createBrokerExecaAdmissionFailure(
  error: Error & { code: string },
): BrokerExecaResult {
  return {
    failed: true,
    code: error.code,
    timedOut: false,
    isCanceled: false,
    isGracefullyCanceled: false,
    isMaxBuffer: false,
    isTerminated: false,
    isForcefullyTerminated: false,
    command: "",
    escapedCommand: "",
    cwd: process.cwd(),
    durationMs: 0,
    error: serializeExecaError(error),
  };
}
