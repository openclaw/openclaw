import fs from "node:fs/promises";
export async function fileExists(filePath) {
    if (!filePath) {
        return false;
    }
    try {
        await fs.stat(filePath);
        return true;
    }
    catch {
        return false;
    }
}
