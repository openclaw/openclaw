import { randomBytes, randomUUID } from "node:crypto";
export function generateSecureUuid() {
    return randomUUID();
}
export function generateSecureToken(bytes = 16) {
    return randomBytes(bytes).toString("base64url");
}
