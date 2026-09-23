// Session file helpers share bounded random-access reads across transcript consumers.
import type { FileHandle } from "node:fs/promises";
import { readFileWindowFully } from "../../infra/file-read.js";

export async function readFileRangeAsync(
  fileHandle: FileHandle,
  position: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const bytesRead = await readFileWindowFully(fileHandle, buffer, position);
  return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
}
