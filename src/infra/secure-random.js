import { randomBytes, randomInt, randomUUID } from "node:crypto";
export function generateSecureUuid() {
    return randomUUID();
}
export function generateSecureToken(bytes = 16) {
    return randomBytes(bytes).toString("base64url");
}
export function generateSecureHex(bytes = 16) {
    return randomBytes(bytes).toString("hex");
}
/** Returns a cryptographically secure fraction in the range [0, 1). */
export function generateSecureFraction() {
    return randomBytes(4).readUInt32BE(0) / 0x1_0000_0000;
}
export function generateSecureInt(a, b) {
    return typeof b === "number" ? randomInt(a, b) : randomInt(a);
}
