import crypto from "node:crypto";
import fs from "node:fs/promises";

export function sha256Bytes(input: Buffer | Uint8Array | string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export async function sha256File(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return sha256Bytes(content);
}

export async function verifyHashConsistency(params: {
  bundlePath?: string;
  bundle?: Buffer | Uint8Array;
  expectedSha256: string;
}): Promise<boolean> {
  const actual = params.bundlePath
    ? await sha256File(params.bundlePath)
    : sha256Bytes(params.bundle ?? Buffer.alloc(0));
  return actual === params.expectedSha256;
}
