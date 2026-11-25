import type { DatabaseEngineSelection } from "../infra/database-engine/types.js";
import type { OpenClawStateReadRequest } from "./openclaw-state-read.types.js";

// Boot selections are frozen; offline porting can update its task-scoped holder.
const engineSelectionBytes = new WeakMap<DatabaseEngineSelection, number>();

// eslint-disable-next-line no-control-regex -- JSON escapes every C0 control character.
const jsonEscapes = /["\\\u0000-\u001f\ud800-\udfff]/u;
const nonPlainAscii = /[^\x20-\x21\x23-\x5b\x5d-\x7e]/;

// Keep JSON's escaped-string charge without allocating the serialized string.
function quotedStringBytes(value: string): number {
  // Printable ASCII without quotes/backslashes needs neither UTF-8 nor escape accounting.
  if (!nonPlainAscii.test(value)) {
    return value.length + 2;
  }
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
function commandBytes(value: unknown): number {
  if (typeof value === "string") {
    return quotedStringBytes(value);
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
    let bytes = 0;
    for (const entry of value) {
      bytes += 8 + commandBytes(entry);
    }
    return bytes;
  }
  let bytes = 0;
  // SAFETY: Captured command/context objects expose their own enumerable string fields.
  const record = value as Record<string, unknown>;
  for (const key in record) {
    if (Object.hasOwn(record, key)) {
      bytes += Buffer.byteLength(key, "utf8") + 8 + commandBytes(record[key]);
    }
  }
  return bytes;
}

function pathBytes(value: string | undefined): number {
  return value === undefined ? 0 : Buffer.byteLength(value, "utf8");
}

export function requestBytes(request: OpenClawStateReadRequest): number {
  const selection = request.context.databaseEngineSelection;
  let selectionBytes = selection && engineSelectionBytes.get(selection);
  if (selectionBytes === undefined) {
    selectionBytes = commandBytes(selection);
    if (selection && Object.isFrozen(selection)) {
      engineSelectionBytes.set(selection, selectionBytes);
    }
  }
  let environmentBytes = 0;
  for (const key in request.context.environment) {
    if (Object.hasOwn(request.context.environment, key)) {
      environmentBytes +=
        Buffer.byteLength(key, "utf8") + pathBytes(request.context.environment[key]);
    }
  }
  // Type-only commands have no caller payload. Extra fields always take the full walk.
  const bytes =
    Object.keys(request.command).length === 1
      ? 12 + quotedStringBytes(request.command.type)
      : commandBytes(request.command);
  return (
    bytes +
    selectionBytes +
    environmentBytes +
    pathBytes(request.context.existingSchemaPath) +
    pathBytes(request.databasePath) +
    pathBytes(request.location) +
    pathBytes(request.expectedIdentity) +
    pathBytes(request.snapshotRoot) +
    pathBytes(request.postgresSnapshot)
  );
}
