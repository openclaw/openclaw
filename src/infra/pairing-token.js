import { randomBytes } from "node:crypto";
import { safeEqualSecret } from "../security/secret-equal.js";
export const PAIRING_TOKEN_BYTES = 32;
export function generatePairingToken() {
    return randomBytes(PAIRING_TOKEN_BYTES).toString("base64url");
}
export function verifyPairingToken(provided, expected) {
    if (provided.trim().length === 0 || expected.trim().length === 0) {
        return false;
    }
    return safeEqualSecret(provided, expected);
}
