import { stripVTControlCharacters } from "node:util";

type OutputStream = "stdout" | "stderr";
export type ExecaMessageOutput = Partial<Record<OutputStream, string | Uint8Array>>;
export type EncodedExecaMessage = { message: string; messageOutputs?: OutputStream[] };

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
export function encodeExecaMessage(
  message: string,
  output: ExecaMessageOutput,
): EncodedExecaMessage {
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

export function decodeExecaMessage(
  encoded: EncodedExecaMessage,
  output: ExecaMessageOutput,
): string {
  return encoded.messageOutputs
    ? [
        encoded.message,
        ...encoded.messageOutputs.map((stream) => renderOutput(output[stream])),
      ].join("\n\n")
    : encoded.message;
}
