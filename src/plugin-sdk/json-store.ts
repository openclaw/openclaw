import path from "node:path";
import { pathExists } from "../infra/fs-safe.js";
import { loadJsonFile, readJsonFile, saveJsonFile } from "../infra/json-file.js";
import { writePrivateJsonAtomic } from "../infra/private-file-store.js";

/** Read small JSON blobs synchronously for token/state caches. */
export { loadJsonFile };

/** Persist small JSON blobs synchronously with restrictive permissions. */
export { saveJsonFile };

/** Read JSON from disk and fall back cleanly when the file is missing or invalid. */
export async function readJsonFileWithFallback<T>(
  filePath: string,
  fallback: T,
): Promise<{ value: T; exists: boolean }> {
  const parsed = await readJsonFile<T>(filePath);
  if (parsed != null) {
    return { value: parsed, exists: true };
  }
  return { value: fallback, exists: await pathExists(filePath) };
}

/** Write JSON with secure file permissions and atomic replacement semantics. */
export async function writeJsonFileAtomically(filePath: string, value: unknown): Promise<void> {
  await writePrivateJsonAtomic({
    rootDir: path.dirname(filePath),
    filePath,
    value,
    trailingNewline: true,
  });
}
