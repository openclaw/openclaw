import crypto from "node:crypto";

/** Generates a new 192-bit gateway token encoded as hex. */
export function randomToken(): string {
  return crypto.randomBytes(24).toString("hex");
}
