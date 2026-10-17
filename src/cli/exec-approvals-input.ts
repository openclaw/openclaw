import { isUtf8 } from "node:buffer";
import fs from "node:fs/promises";
import { readByteStreamWithLimit } from "@openclaw/media-core/read-byte-stream-with-limit";
import { readFileDescriptorBounded } from "../infra/boundary-file-read.js";

const EXEC_APPROVALS_STDIN_MAX_BYTES = 1024 * 1024;

function decodeApprovalsInput(bytes: Buffer, source: string): string {
  if (!isUtf8(bytes)) {
    throw new Error(`${source} must be valid UTF-8.`);
  }
  return bytes.toString("utf8");
}

export async function readStdin(
  stream: NodeJS.ReadableStream = process.stdin,
  maxBytes = EXEC_APPROVALS_STDIN_MAX_BYTES,
): Promise<string> {
  const bytes = await readByteStreamWithLimit(stream, {
    maxBytes,
    onOverflow: ({ maxBytes: limit }) => new Error(`Exec approvals stdin exceeds ${limit} bytes.`),
  });
  return decodeApprovalsInput(bytes, "Exec approvals stdin");
}

export async function readApprovalsFile(filePath: string): Promise<string> {
  // Explicit CLI file inputs have historically followed symlinks and readable
  // special files. Pin that opened target while bounding the bytes consumed.
  const handle = await fs.open(filePath, "r");
  try {
    return decodeApprovalsInput(
      await readFileDescriptorBounded(handle.fd, EXEC_APPROVALS_STDIN_MAX_BYTES),
      "Exec approvals file",
    );
  } finally {
    await handle.close();
  }
}
