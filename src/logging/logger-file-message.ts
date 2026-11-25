import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { RedactionMessage } from "./redact-json.js";

const MAX_FILE_LOG_MESSAGE_CHARS = 4 * 1024;

function clampMessage(text: string): string {
  return text.length > MAX_FILE_LOG_MESSAGE_CHARS
    ? `${truncateUtf16Safe(text, MAX_FILE_LOG_MESSAGE_CHARS)}...(truncated)`
    : text;
}

function stringifyFileLogMessagePart(value: unknown, json: boolean): string | undefined {
  if (json) {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (isRecord(value) && typeof value.message === "string") {
    return value.message;
  }
  return undefined;
}

export type FileLogMessagePart = {
  key: string;
  json: boolean;
  primitiveText?: string;
};

export function serializeFileLogRecord(
  record: Record<string, unknown>,
  parts: readonly FileLogMessagePart[] = [],
): string {
  const ancestors: object[] = [];
  // Materialize native values once so the display message cannot invoke toJSON again.
  const materialized: unknown = JSON.parse(
    JSON.stringify(record, function (_key, value: unknown) {
      while (ancestors.length > 0 && ancestors.at(-1) !== this) {
        ancestors.pop();
      }
      if (typeof value === "bigint") {
        return String(value);
      }
      if (value !== null && typeof value === "object") {
        if (ancestors.includes(value)) {
          return "[Circular]";
        }
        ancestors.push(value);
      }
      return value;
    }),
  );
  if (!isRecord(materialized)) {
    throw new TypeError("File log records must serialize to objects");
  }
  const text: string[] = [];
  for (const { key, json, primitiveText } of parts) {
    const part = primitiveText ?? stringifyFileLogMessagePart(materialized[key], json);
    if (part?.trim()) {
      text.push(part);
    }
  }
  if (text.length > 0) {
    const message = clampMessage(text.join(" "));
    if (Object.hasOwn(materialized, "message")) {
      materialized.message = message;
    } else {
      const entries = Object.entries(materialized);
      entries.splice(entries.findIndex(([key]) => key === "hostname") + 1, 0, ["message", message]);
      return JSON.stringify(Object.fromEntries(entries));
    }
  }
  return JSON.stringify(materialized);
}

/** Locate display copies in raw JSONL so egress masks follow their structured source. */
export function getFileLogRedactionMessage(
  record: Record<string, unknown>,
): RedactionMessage | undefined {
  if (typeof record.message !== "string") {
    return undefined;
  }
  const text = record.message;
  const contentLength = text.endsWith("...(truncated)")
    ? text.length - "...(truncated)".length
    : text.length;
  const parts: RedactionMessage["parts"] = [];
  let cursor = 0;
  for (const [key, value] of Object.entries(record)
    .filter(([fieldKey]) => /^\d+$/.test(fieldKey))
    .toSorted((a, b) => Number(a[0]) - Number(b[0]))) {
    const json = value !== null && typeof value === "object";
    const candidates = [
      { value: stringifyFileLogMessagePart(value, json), json, messageField: false },
      ...(json && isRecord(value) && typeof value.message === "string"
        ? [{ value: value.message, json: false, messageField: true }]
        : []),
    ];
    for (const candidate of candidates) {
      if (!candidate.value?.trim()) {
        continue;
      }
      let start = text.indexOf(candidate.value, cursor);
      if (start < 0 && contentLength < text.length) {
        // A truncated display can end inside a credential; project its visible prefix too.
        for (let index = cursor; index < contentLength; index += 1) {
          if (candidate.value.startsWith(text.slice(index, contentLength))) {
            start = index;
            break;
          }
        }
      }
      if (start >= 0 && start < contentLength) {
        parts.push({ key, json: candidate.json, messageField: candidate.messageField, start });
        cursor = start + candidate.value.length;
        break;
      }
    }
  }
  return { text, contentLength, parts, finish: clampMessage };
}
