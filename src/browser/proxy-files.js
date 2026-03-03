import { saveMediaBuffer } from "../media/store.js";
export async function persistBrowserProxyFiles(files) {
    if (!files || files.length === 0) {
        return new Map();
    }
    const mapping = new Map();
    for (const file of files) {
        const buffer = Buffer.from(file.base64, "base64");
        const saved = await saveMediaBuffer(buffer, file.mimeType, "browser", buffer.byteLength);
        mapping.set(file.path, saved.path);
    }
    return mapping;
}
export function applyBrowserProxyPaths(result, mapping) {
    if (!result || typeof result !== "object") {
        return;
    }
    const obj = result;
    if (typeof obj.path === "string" && mapping.has(obj.path)) {
        obj.path = mapping.get(obj.path);
    }
    if (typeof obj.imagePath === "string" && mapping.has(obj.imagePath)) {
        obj.imagePath = mapping.get(obj.imagePath);
    }
    const download = obj.download;
    if (download && typeof download === "object") {
        const d = download;
        if (typeof d.path === "string" && mapping.has(d.path)) {
            d.path = mapping.get(d.path);
        }
    }
}
