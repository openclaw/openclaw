import { timingSafeEqual } from "node:crypto";

function padSecretBytes(bytes: Buffer, length: number): Buffer {
  if (bytes.length === length) {
    return bytes;
  }
  const padded = Buffer.alloc(length);
  bytes.copy(padded);
  return padded;
}

export function safeEqualSecret(
  provided: string | undefined | null,
  expected: string | undefined | null,
): boolean {
  // Normalize null/undefined to empty string to ensure constant-time comparison
  const p = typeof provided === "string" ? provided : "";
  const e = typeof expected === "string" ? expected : "";
  const hash = (s: string) => createHash("sha256").update(s).digest();
  const isEqual = timingSafeEqual(hash(p), hash(e));
  return isEqual && typeof provided === "string" && typeof expected === "string";
}
