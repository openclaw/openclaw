import crypto from "node:crypto";
export function randomToken() {
    return crypto.randomBytes(24).toString("hex");
}
