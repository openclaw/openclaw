import type { FileHandle } from "node:fs/promises";

/** Fills a bounded positional-read buffer unless the file reaches EOF. */
export async function readFileWindowFully(
  handle: FileHandle,
  buffer: Buffer,
  position: number,
): Promise<number> {
  let bytesRead = 0;
  while (bytesRead < buffer.length) {
    const result = await handle.read(
      buffer,
      bytesRead,
      buffer.length - bytesRead,
      position + bytesRead,
    );
    if (result.bytesRead === 0) {
      break;
    }
    bytesRead += result.bytesRead;
  }
  return bytesRead;
}
