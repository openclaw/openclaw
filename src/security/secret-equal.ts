import { createHmac, timingSafeEqual } from "node:crypto";

export function safeEqualSecret(
  provided: string | undefined | null,
  expected: string | undefined | null,
): boolean {
  // Normalize null/undefined to empty string to ensure constant-time comparison
  const p = typeof provided === "string" ? provided : "";
  const e = typeof expected === "string" ? expected : "";
  const hash = (s: string) => createHmac("sha256", "openclaw-safe-equal").update(s).digest();
  const isEqual = timingSafeEqual(hash(p), hash(e)) ? 1 : 0;
  const pIsString = typeof provided === "string" ? 1 : 0;
  const eIsString = typeof expected === "string" ? 1 : 0;
  return Boolean(isEqual & pIsString & eIsString);
}
