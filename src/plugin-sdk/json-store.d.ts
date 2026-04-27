import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
/** Read small JSON blobs synchronously for token/state caches. */
export { loadJsonFile };
/** Persist small JSON blobs synchronously with restrictive permissions. */
export { saveJsonFile };
/** Read JSON from disk and fall back cleanly when the file is missing or invalid. */
export declare function readJsonFileWithFallback<T>(filePath: string, fallback: T): Promise<{
    value: T;
    exists: boolean;
}>;
/** Write JSON with secure file permissions and atomic replacement semantics. */
export declare function writeJsonFileAtomically(filePath: string, value: unknown): Promise<void>;
