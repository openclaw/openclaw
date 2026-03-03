export function jsonUtf8Bytes(value) {
    try {
        return Buffer.byteLength(JSON.stringify(value), "utf8");
    }
    catch {
        return Buffer.byteLength(String(value), "utf8");
    }
}
