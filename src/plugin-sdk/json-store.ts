// JSON store helpers provide small atomic persistence primitives for plugin runtime state.
import { tryReadJsonSync, writeJson, writeJsonSync } from "../infra/json-files.js";

/** Read small JSON blobs synchronously for token/state caches. */
// oxlint-disable-next-line typescript-eslint/no-unnecessary-type-parameters -- public SDK compatibility helper.
export function loadJsonFile<T = unknown>(filePath: string): T | undefined {
  return tryReadJsonSync<T>(filePath) ?? undefined;
}

/** Persist small JSON blobs synchronously with restrictive permissions. */
export const saveJsonFile = writeJsonSync;

/** Write JSON with secure file permissions and atomic replacement semantics. */
export async function writeJsonFileAtomically(filePath: string, value: unknown): Promise<void> {
  await writeJson(filePath, value, {
    mode: 0o600,
    dirMode: 0o700,
    trailingNewline: true,
  });
}
