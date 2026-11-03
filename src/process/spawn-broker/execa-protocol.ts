import { stripVTControlCharacters } from "node:util";
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
