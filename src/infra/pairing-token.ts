import { randomBytes } from "node:crypto";
import { safeEqualSecret } from "../security/secret-equal.js";

export const PAIRING_TOKEN_BYTES = 32;

export function generatePairingToken(): string {
  return randomBytes(PAIRING_TOKEN_BYTES).toString("base64url");
}

export function verifyPairingToken(provided: string, expected: string): boolean {
  return safeEqualSecret(provided, expected);
}
