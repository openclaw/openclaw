import { createHash, timingSafeEqual } from "node:crypto";
export function safeEqualSecret(provided, expected) {
    if (typeof provided !== "string" || typeof expected !== "string") {
        return false;
    }
    const hash = (s) => createHash("sha256").update(s).digest();
    return timingSafeEqual(hash(provided), hash(expected));
}
