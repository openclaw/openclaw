// Bounded UTF-8 input for ordinary Gateway and embedded agent turns.
import fs from "node:fs/promises";
import { TextDecoder } from "node:util";
import { readByteStreamWithLimit } from "@openclaw/media-core/read-byte-stream-with-limit";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readFileDescriptorBounded } from "../infra/boundary-file-read.js";

const MESSAGE_FILE_DECODER = new TextDecoder("utf-8", { fatal: true });

function formatTextFileReadFailure(label: string, inputFile: string, err: unknown): string {
  const code = asOptionalRecord(err)?.code;
  if (code === "ENOENT") {
    return `${label} file not found: ${inputFile}`;
  }
  if (code === "EISDIR") {
    return `${label} file is a directory: ${inputFile}`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `Unable to read ${label.toLowerCase()} file ${inputFile}: ${message}`;
}

// Agent messages are prompt text; a 4 MiB cap gives generous headroom for
// long system prompts while preventing a symlink/huge-file path from OOMing
// the CLI before dispatch.
const AGENT_MESSAGE_FILE_MAX_BYTES = 4 * 1024 * 1024;

export async function readBoundedCliTextInput(
  inputFile: string,
  options?: { maxBytes?: number; label?: string },
): Promise<string> {
  const maxBytes = options?.maxBytes ?? AGENT_MESSAGE_FILE_MAX_BYTES;
  const label = options?.label ?? "Message";
  let buffer: Buffer;
  if (inputFile === "-") {
    buffer = await readByteStreamWithLimit(process.stdin, {
      maxBytes,
      onOverflow: () => new Error(`${label} stdin exceeds ${maxBytes} bytes`),
    });
  } else {
    // Open the original path so the kernel preserves symlink and procfs magic-link
    // behavior (notably piped /dev/stdin), then inspect that exact descriptor.
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(inputFile, "r");
      const stat = await handle.stat();
      if (stat.isDirectory()) {
        // Keep the legacy fs.readFile directory UX.
        throw Object.assign(new Error(`${label} file is a directory`), { code: "EISDIR" });
      }
      // Regular files fail fast. Streams report size 0, so the descriptor reader
      // enforces the same limit byte-by-byte while preserving FIFO behavior.
      if (stat.isFile() && stat.size > maxBytes) {
        throw new Error(`File exceeds ${maxBytes} bytes: ${inputFile}`);
      }
      buffer = await readFileDescriptorBounded(handle.fd, maxBytes);
    } catch (err) {
      throw new Error(formatTextFileReadFailure(label, inputFile, err), { cause: err });
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  let text: string;
  try {
    text = MESSAGE_FILE_DECODER.decode(buffer).replace(/^\uFEFF/, "");
  } catch {
    throw new Error(
      inputFile === "-"
        ? `${label} stdin must be valid UTF-8`
        : `${label} file must be valid UTF-8: ${inputFile}`,
    );
  }
  if (!text.trim()) {
    throw new Error(
      inputFile === "-" ? `${label} stdin is empty` : `${label} file is empty: ${inputFile}`,
    );
  }
  return text;
}

export async function readAgentMessageFile(messageFile: string): Promise<string> {
  return readBoundedCliTextInput(messageFile);
}
