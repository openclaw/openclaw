import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const CONTROL_PENDING_LINE_LIMIT_BYTES = 256 * 1024;

export function readServiceChildControl(
  control: Readable,
  onLine: (line: string) => void,
  onOverflow: () => void,
): void {
  let pending = "";
  let pendingBytes = 0;
  let decoder = new StringDecoder("utf8");
  const reset = () => {
    pending = "";
    pendingBytes = 0;
    decoder = new StringDecoder("utf8");
  };
  // Keep raw bytes until the line cap accepts each fragment.
  // String mode decodes a complete oversized frame before this parser can reject it.
  control.on("data", (chunk: Buffer) => {
    let offset = 0;
    for (;;) {
      const searchLength = CONTROL_PENDING_LINE_LIMIT_BYTES - pendingBytes + 1;
      const boundedChunk = chunk.subarray(offset, offset + searchLength);
      const newline = boundedChunk.indexOf(0x0a);
      if (newline < 0) {
        if (boundedChunk.length === searchLength) {
          onOverflow();
          reset();
        } else {
          pending += decoder.write(boundedChunk);
          pendingBytes += boundedChunk.length;
        }
        return;
      }
      const line = pending + decoder.end(boundedChunk.subarray(0, newline));
      reset();
      onLine(line);
      offset += newline + 1;
    }
  });
}
