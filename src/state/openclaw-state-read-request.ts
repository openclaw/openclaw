import type { OpenClawStateReadRequest } from "./openclaw-state-read.types.js";

// eslint-disable-next-line no-control-regex -- JSON escapes every C0 control character.
const jsonEscapes = /["\\\u0000-\u001f\ud800-\udfff]/u;

// Keep JSON's escaped-string charge without allocating the serialized string.
function quotedStringBytes(value: string): number {
  let bytes = Buffer.byteLength(value, "utf8") + 2;
  if (!jsonEscapes.test(value)) {
    return bytes;
  }
  for (let index = 0; index < value.length; index++) {
    const code = value.codePointAt(index)!;
    if (code < 0x20) {
      bytes += code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 1 : 5;
    } else if (code === 0x22 || code === 0x5c) {
      bytes++;
    } else if (code >= 0xd800 && code <= 0xdfff) {
      // JSON escapes lone surrogates; UTF-8 byteLength counts a replacement character.
      bytes += 3;
    } else if (code > 0xffff) {
      index++;
    }
  }
  return bytes;
}

// Account for the captured payload, not a second per-command schema. Object keys
// and escaped strings deliberately overcharge the queue rather than omit new fields.
function commandBytes(value: unknown, rawStrings = false): number {
  if (typeof value === "string") {
    return rawStrings ? Buffer.byteLength(value, "utf8") : quotedStringBytes(value);
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return 8;
  }
  if (typeof value === "boolean") {
    return 1;
  }
  if (value === null || value === undefined) {
    return 0;
  }
  if (Array.isArray(value)) {
    return value.reduce(
      (bytes, entry) => bytes + (rawStrings ? 0 : 8) + commandBytes(entry, rawStrings),
      0,
    );
  }
  let bytes = 0;
  // SAFETY: Captured command/context objects expose their own enumerable string fields.
  const record = value as Record<string, unknown>;
  for (const key in record) {
    if (Object.hasOwn(record, key)) {
      bytes +=
        Buffer.byteLength(key, "utf8") +
        (rawStrings ? 0 : 8) +
        commandBytes(record[key], rawStrings);
    }
  }
  return bytes;
}

export function requestBytes(request: OpenClawStateReadRequest): number {
  return (
    commandBytes(request.command) +
    commandBytes(request.context.databaseEngineSelection) +
    commandBytes(request.context.environment, true) +
    commandBytes(
      [
        request.context.existingSchemaPath,
        request.databasePath,
        request.location,
        request.expectedIdentity,
        request.snapshotRoot,
        request.postgresSnapshot,
      ],
      true,
    )
  );
}
