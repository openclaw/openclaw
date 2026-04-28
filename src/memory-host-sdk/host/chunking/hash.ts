import crypto from "node:crypto";

/** Compute SHA-256 hex hash of a string. */
export function hashText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
