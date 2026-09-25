import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { readFileWindowFullySync } from "@openclaw/fs-safe/advanced";

// A session header is one JSON line that may be longer than a single read. Scan it
// in chunks and stop at the first newline: `StringDecoder` carries a multibyte
// sequence that a chunk boundary splits, whereas decoding one fixed window with
// `toString("utf8")` turns that split character into U+FFFD and the header stops
// parsing. HEADER_MAX_CHARS bounds the scan so an unterminated file cannot be read
// indefinitely.
const HEADER_CHUNK_BYTES = 8192;
const HEADER_MAX_CHARS = 1024 * 1024;

/** Reads the first newline-terminated line of a file, or undefined when there is none. */
export function readFirstLineSync(filePath: string): string | undefined {
  const fd = fs.openSync(filePath, "r");
  try {
    const decoder = new StringDecoder("utf8");
    const chunk = Buffer.alloc(HEADER_CHUNK_BYTES);
    let carry = "";
    for (let position = 0; ;) {
      const bytesRead = readFileWindowFullySync(fd, chunk, position);
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
  } finally {
    fs.closeSync(fd);
  }
}
