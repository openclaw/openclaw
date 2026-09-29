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

export function buildFileLogMessage(
  record: Record<string, unknown>,
  parts: readonly FileLogMessagePart[],
): RedactionMessage | undefined {
  const text: string[] = [];
  const spans: RedactionMessage["parts"] = [];
  let length = 0;
  for (const { key, json, primitiveText } of parts) {
    const value = record[key];
    const part = primitiveText ?? stringifyFileLogMessagePart(value, json);
    if (!part?.trim()) {
      continue;
    }
    if (text.length > 0) {
      length += 1;
    }
    spans.push({
      key,
      json,
      messageField: !json && isRecord(value),
      start: length,
      ...(primitiveText === undefined ? {} : { primitiveLength: primitiveText.length }),
    });
    text.push(part);
    length += part.length;
  }
  if (text.length === 0) {
    return undefined;
  }
  const joined = text.join(" ");
  const prefix = truncateUtf16Safe(joined, MAX_FILE_LOG_MESSAGE_CHARS);
  const textValue = clampMessage(joined);
  return {
    text: textValue,
    contentLength: prefix.length,
    finish: (value) => (value === textValue ? value : clampMessage(value)),
    parts: spans,
  };
}
