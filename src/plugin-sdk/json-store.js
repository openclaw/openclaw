import fs from "node:fs";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import { writeJsonAtomic } from "../infra/json-files.js";
import { safeParseJson } from "../utils.js";
/** Read small JSON blobs synchronously for token/state caches. */
export { loadJsonFile };
/** Persist small JSON blobs synchronously with restrictive permissions. */
export { saveJsonFile };
/** Read JSON from disk and fall back cleanly when the file is missing or invalid. */
export async function readJsonFileWithFallback(filePath, fallback) {
    try {
        const raw = await fs.promises.readFile(filePath, "utf-8");
        const parsed = safeParseJson(raw);
        if (parsed == null) {
            return { value: fallback, exists: true };
        }
        return { value: parsed, exists: true };
    }
    catch (err) {
        const code = err.code;
        if (code === "ENOENT") {
            return { value: fallback, exists: false };
        }
        return { value: fallback, exists: false };
    }
}
/** Write JSON with secure file permissions and atomic replacement semantics. */
export async function writeJsonFileAtomically(filePath, value) {
    await writeJsonAtomic(filePath, value, {
        mode: 0o600,
        trailingNewline: true,
        ensureDirMode: 0o700,
    });
}
