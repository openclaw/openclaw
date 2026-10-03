import fs from "node:fs/promises";
import { readByteStreamWithLimit } from "@openclaw/media-core/read-byte-stream-with-limit";
import { readFileDescriptorBounded } from "../infra/boundary-file-read.js";

const EXEC_APPROVALS_STDIN_MAX_BYTES = 1024 * 1024;

export async function readStdin(
  stream: NodeJS.ReadableStream = process.stdin,
  maxBytes = EXEC_APPROVALS_STDIN_MAX_BYTES,
): Promise<string> {
  const bytes = await readByteStreamWithLimit(stream, {
    maxBytes,
    onOverflow: ({ maxBytes: limit }) => new Error(`Exec approvals stdin exceeds ${limit} bytes.`),
  });
  return bytes.toString("utf8");
}

export async function readApprovalsFile(filePath: string): Promise<string> {
  // Explicit CLI file inputs have historically followed symlinks and readable
  // special files. Pin that opened target while bounding the bytes consumed.
  const handle = await fs.open(filePath, "r");
  try {
    return (await readFileDescriptorBounded(handle.fd, EXEC_APPROVALS_STDIN_MAX_BYTES)).toString(
      "utf8",
    );
  } finally {
    await handle.close();
  }
}
