import crypto from "node:crypto";
export function hashText(value) {
    return crypto.createHash("sha256").update(value).digest("hex");
}
