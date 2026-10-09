// Bounded UTF-8 input for ordinary Gateway and embedded agent turns.
import fs from "node:fs/promises";
import { TextDecoder } from "node:util";
import { readByteStreamWithLimit } from "@openclaw/media-core/read-byte-stream-with-limit";
import { readFileDescriptorBounded } from "../infra/boundary-file-read.js";

const AGENT_MESSAGE_FILE_MAX_BYTES = 4 * 1024 * 1024;
const MESSAGE_FILE_DECODER = new TextDecoder("utf-8", { fatal: true });

function formatMessageFileReadFailure(messageFile: string, err: unknown): string {
  const code =
    typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
      ? err.code
      : "";
  if (code === "ENOENT") {
    return `Message file not found: ${messageFile}`;
  }
  if (code === "EISDIR") {
    return `Message file is a directory: ${messageFile}`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `Unable to read message file ${messageFile}: ${message}`;
}

export async function readAgentMessageFile(messageFile: string): Promise<string> {
  let buffer: Buffer;
  if (messageFile === "-") {
    buffer = await readByteStreamWithLimit(process.stdin, {
      maxBytes: AGENT_MESSAGE_FILE_MAX_BYTES,
      onOverflow: () => new Error(`Message stdin exceeds ${AGENT_MESSAGE_FILE_MAX_BYTES} bytes`),
    });
  } else {
    // Keep the original descriptor reader for symlinks, procfs links and FIFOs.
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try {
      handle = await fs.open(messageFile, "r");
    } catch (err) {
      throw new Error(formatMessageFileReadFailure(messageFile, err), { cause: err });
    }
    try {
      const stat = await handle.stat();
      if (stat.isDirectory()) {
        throw Object.assign(new Error("Message file is a directory"), { code: "EISDIR" });
      }
      if (stat.isFile() && stat.size > AGENT_MESSAGE_FILE_MAX_BYTES) {
        throw new Error(`File exceeds ${AGENT_MESSAGE_FILE_MAX_BYTES} bytes: ${messageFile}`);
      }
      buffer = await readFileDescriptorBounded(handle.fd, AGENT_MESSAGE_FILE_MAX_BYTES);
    } catch (err) {
      throw new Error(formatMessageFileReadFailure(messageFile, err), { cause: err });
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
  try {
    return MESSAGE_FILE_DECODER.decode(buffer).replace(/^\uFEFF/, "");
  } catch {
    throw new Error(
      `Message ${messageFile === "-" ? "stdin" : "file"} must be valid UTF-8: ${messageFile}`,
    );
  }
}
