import { Buffer } from "node:buffer";
export function rawDataToString(data, encoding = "utf8") {
    if (typeof data === "string") {
        return data;
    }
    if (Buffer.isBuffer(data)) {
        return data.toString(encoding);
    }
    if (Array.isArray(data)) {
        return Buffer.concat(data).toString(encoding);
    }
    if (data instanceof ArrayBuffer) {
        return Buffer.from(data).toString(encoding);
    }
    return Buffer.from(String(data)).toString(encoding);
}
