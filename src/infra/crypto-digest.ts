import { createHash, hash } from "node:crypto";
import { closeSync, createReadStream, openSync } from "node:fs";
import { sha256FileSync as sha256FileSyncBase } from "@openclaw/fs-safe/durability";

export { sha256Hex, sha256HexPrefixCore } from "@openclaw/normalization-core/node-crypto";

type DigestInput = string | Uint8Array;

export function sha256Base64(input: DigestInput): string {
  return hash("sha256", input, "base64");
}

export function sha256Base64Url(input: DigestInput): string {
  return hash("sha256", input, "base64url");
}

export function sha256Base64UrlPrefix(input: DigestInput, length: number): string {
  return sha256Base64Url(input).slice(0, length);
}

/** Matches the streaming helper's symlink-following path contract. */
export function sha256FileSync(filePath: string): string {
  const descriptor = openSync(filePath, "r");
  try {
    return sha256FileSyncBase(descriptor).digest;
  } finally {
    closeSync(descriptor);
  }
}

/** Streams a file, optionally stopping at an inclusive byte offset. */
export async function sha256File(filePath: string, end?: number): Promise<string> {
  const digest = createHash("sha256");
  try {
    for await (const chunk of createReadStream(filePath, { end, highWaterMark: 256 * 1024 })) {
      digest.update(chunk);
    }
  } catch (err) {
    throw new Error(
      `Failed to hash file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  return digest.digest("hex");
}
