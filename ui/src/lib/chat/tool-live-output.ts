import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { LiveToolOutput } from "./chat-types.ts";

export function readLiveToolOutput(value: unknown): LiveToolOutput | undefined {
  return isRecord(value) &&
    typeof value.text === "string" &&
    typeof value.omittedChars === "number" &&
    Number.isSafeInteger(value.omittedChars) &&
    value.omittedChars >= 0
    ? { text: value.text, omittedChars: value.omittedChars }
    : undefined;
}
