import "../infra/fs-safe-defaults.js";
import { pathExists } from "../infra/fs-safe.js";
import { tryReadJson, tryReadJsonSync, writeJson, writeJsonSync } from "../infra/json-files.js";

/**
 * Read external JSON inputs such as package manifests, tool config, or
 * doctor/import sources. OpenClaw runtime state and caches should use SQLite
 * stores instead.
 */
// oxlint-disable-next-line typescript-eslint/no-unnecessary-type-parameters -- public SDK compatibility helper.
export function loadJsonFile<T = unknown>(filePath: string): T | undefined {
  return tryReadJsonSync<T>(filePath) ?? undefined;
}

/** Persist external JSON config files only; do not use for OpenClaw runtime state. */
export const saveJsonFile = writeJsonSync;

/** Read external JSON and fall back cleanly when the file is missing or invalid. */
export async function readJsonFileWithFallback<T>(
  filePath: string,
  fallback: T,
): Promise<{ value: T; exists: boolean }> {
  const parsed = await tryReadJson<T>(filePath);
  if (parsed != null) {
    return { value: parsed, exists: true };
  }
  return { value: fallback, exists: await pathExists(filePath) };
}

/** Write external JSON config/import material with atomic replacement semantics. */
export async function writeJsonFileAtomically(filePath: string, value: unknown): Promise<void> {
  await writeJson(filePath, value, {
    mode: 0o600,
    dirMode: 0o700,
    trailingNewline: true,
  });
}
