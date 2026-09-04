import { StringDecoder } from "node:string_decoder";

export const DEFAULT_CHILD_OUTPUT_TAIL_BYTES = 128 * 1024;

export function decodeUtf8Tail(buffer: Buffer): string {
  let start = 0;
  while (start < buffer.length && (buffer[start]! & 0b1100_0000) === 0b1000_0000) {
    start += 1;
  }
  return new StringDecoder("utf8").end(buffer.subarray(start));
}

export function createBoundedChildOutput(maxBytes = DEFAULT_CHILD_OUTPUT_TAIL_BYTES) {
  const limit =
    Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_CHILD_OUTPUT_TAIL_BYTES;
  let chunks: Buffer[] = [];
  let totalBytes = 0;

  const trim = () => {
    while (totalBytes > limit && chunks.length > 0) {
      const first = chunks[0];
      if (!first) {
        break;
      }
      const excess = totalBytes - limit;
      if (first.byteLength <= excess) {
        chunks.shift();
        totalBytes -= first.byteLength;
        continue;
      }
      chunks[0] = Buffer.from(first.subarray(excess));
      totalBytes -= excess;
      break;
    }
  };

  return {
    append(this: void, chunk: unknown): void {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (buffer.byteLength >= limit) {
        chunks = [Buffer.from(buffer.subarray(buffer.byteLength - limit))];
        totalBytes = limit;
        return;
      }
      chunks.push(buffer);
      totalBytes += buffer.byteLength;
      trim();
    },
    text(): string {
      return decodeUtf8Tail(Buffer.concat(chunks, totalBytes));
    },
  };
}

const LOG_TAIL_MAX_BYTES = 256 * 1024;

type BoundedStringLog = string[] & {
  maxBytes?: number;
  byteLength?: number;
  truncated?: boolean;
};

export function createBoundedStringLog(maxBytes = LOG_TAIL_MAX_BYTES): string[] {
  const log = [] as BoundedStringLog;
  log.maxBytes = Math.max(1, maxBytes);
  log.byteLength = 0;
  log.truncated = false;
  return log;
}

export function appendLogChunk(log: string[], chunk: unknown): void {
  const chunks = log as BoundedStringLog;
  const limit = chunks.maxBytes ?? LOG_TAIL_MAX_BYTES;
  const text = String(chunk);
  const textBytes = Buffer.byteLength(text);
  if (textBytes > limit) {
    const buffer = Buffer.from(text);
    const tail = decodeUtf8Tail(buffer.subarray(buffer.length - limit));
    chunks.splice(0, chunks.length, tail);
    chunks.byteLength = Buffer.byteLength(tail);
    chunks.truncated = true;
    return;
  }

  chunks.push(text);
  chunks.byteLength = (chunks.byteLength ?? 0) + textBytes;
  while ((chunks.byteLength ?? 0) > limit && chunks.length > 0) {
    const first = chunks[0] ?? "";
    const firstBytes = Buffer.byteLength(first);
    const overflow = (chunks.byteLength ?? 0) - limit;
    if (firstBytes <= overflow) {
      chunks.shift();
      chunks.byteLength = (chunks.byteLength ?? 0) - firstBytes;
      chunks.truncated = true;
      continue;
    }

    const buffer = Buffer.from(first);
    // Drop a split prefix instead of expanding it into replacement bytes that can stall trimming.
    const tail = decodeUtf8Tail(buffer.subarray(overflow));
    chunks[0] = tail;
    chunks.byteLength = chunks.reduce((total, entry) => total + Buffer.byteLength(entry), 0);
    chunks.truncated = true;
  }
}

export function readLogBuffer(log: string[]): string {
  const text = log.join("");
  return (log as BoundedStringLog).truncated
    ? `[output truncated to last ${(log as BoundedStringLog).maxBytes ?? LOG_TAIL_MAX_BYTES} bytes]\n${text}`
    : text;
}

export function formatLogs(stdout: string[], stderr: string[]): string {
  const diagnosticTail = (log: string[]): string => {
    const tail = createBoundedStringLog(
      Math.min((log as BoundedStringLog).maxBytes ?? LOG_TAIL_MAX_BYTES, LOG_TAIL_MAX_BYTES),
    ) as BoundedStringLog;
    for (const chunk of log) {
      appendLogChunk(tail, chunk);
    }
    tail.truncated ||= (log as BoundedStringLog).truncated;
    return readLogBuffer(tail);
  };
  return `--- stdout ---\n${diagnosticTail(stdout)}\n--- stderr ---\n${diagnosticTail(stderr)}`;
}
