// Bounded UTF-8 input for ordinary Gateway and embedded agent turns.
import fs from "node:fs/promises";
import { TextDecoder } from "node:util";
import { readByteStreamWithLimit } from "@openclaw/media-core/read-byte-stream-with-limit";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readFileDescriptorBounded } from "../infra/boundary-file-read.js";

const MESSAGE_FILE_DECODER = new TextDecoder("utf-8", { fatal: true });

function formatMessageFileReadFailure(messageFile: string, err: unknown): string {
  const code = asOptionalRecord(err)?.code;
  if (code === "ENOENT") {
    return `Message file not found: ${messageFile}`;
  }
  if (code === "EISDIR") {
    return `Message file is a directory: ${messageFile}`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `Unable to read message file ${messageFile}: ${message}`;
}

// Agent messages are prompt text; a 4 MiB cap gives generous headroom for
// long system prompts while preventing a symlink/huge-file path from OOMing
// the CLI before dispatch.
const AGENT_MESSAGE_FILE_MAX_BYTES = 4 * 1024 * 1024;

export async function readAgentMessageFile(messageFile: string): Promise<string> {
  let buffer: Buffer;
  if (messageFile === "-") {
    buffer = await readByteStreamWithLimit(process.stdin, {
      maxBytes: AGENT_MESSAGE_FILE_MAX_BYTES,
      onOverflow: () => new Error(`Message stdin exceeds ${AGENT_MESSAGE_FILE_MAX_BYTES} bytes`),
    });
  } else {
    // Open the original path so the kernel preserves symlink and procfs magic-link
    // behavior (notably piped /dev/stdin), then inspect that exact descriptor.
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(messageFile, "r");
      const stat = await handle.stat();
      if (stat.isDirectory()) {
        // Keep the legacy fs.readFile directory UX.
        throw Object.assign(new Error("Message file is a directory"), { code: "EISDIR" });
      }
      // Regular files fail fast. Streams report size 0, so the descriptor reader
      // enforces the same limit byte-by-byte while preserving FIFO behavior.
      if (stat.isFile() && stat.size > AGENT_MESSAGE_FILE_MAX_BYTES) {
        throw new Error(`File exceeds ${AGENT_MESSAGE_FILE_MAX_BYTES} bytes: ${messageFile}`);
      }
      buffer = await readFileDescriptorBounded(handle.fd, AGENT_MESSAGE_FILE_MAX_BYTES);
    } catch (err) {
      throw new Error(formatMessageFileReadFailure(messageFile, err), { cause: err });
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  let message: string;
  try {
    message = MESSAGE_FILE_DECODER.decode(buffer).replace(/^\uFEFF/, "");
  } catch {
    throw new Error(
      messageFile === "-"
        ? "Message stdin must be valid UTF-8"
        : `Message file must be valid UTF-8: ${messageFile}`,
    );
  }
  if (!message.trim()) {
    throw new Error(
      messageFile === "-" ? "Message stdin is empty" : `Message file is empty: ${messageFile}`,
    );
  }
  return message;
}
