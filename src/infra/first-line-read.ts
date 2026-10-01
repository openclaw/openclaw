import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { readFileWindowFullySync } from "@openclaw/fs-safe/advanced";

// StringDecoder preserves UTF-8 sequences split across chunks. Bound the scan
// so a missing newline cannot read indefinitely.
const HEADER_CHUNK_BYTES = 8192;
const HEADER_MAX_CHARS = 1024 * 1024;

/** Reads a complete first line, including a nonempty final line at EOF. */
export function readFirstLineSync(
  filePath: string,
  options: { maxBytes?: number } = {},
): string | undefined {
  const fd = fs.openSync(filePath, "r");
  try {
    const decoder = new StringDecoder("utf8");
    const chunk = Buffer.alloc(HEADER_CHUNK_BYTES);
    const maxBytes = options.maxBytes ?? Infinity;
    let carry = "";
    for (let position = 0; position < maxBytes;) {
      const window = chunk.subarray(0, Math.min(chunk.length, maxBytes - position));
      const bytesRead = readFileWindowFullySync(fd, window, position);
      if (bytesRead <= 0) {
        carry += decoder.end();
        return carry.length > 0 ? carry : undefined;
      }
      position += bytesRead;
      carry += decoder.write(chunk.subarray(0, bytesRead));
      const newline = carry.indexOf("\n");
      if (newline >= 0) {
        return carry.slice(0, newline);
      }
      if (carry.length > HEADER_MAX_CHARS) {
        return undefined;
      }
    }
    // A full byte budget without a newline cannot establish a complete line.
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}
