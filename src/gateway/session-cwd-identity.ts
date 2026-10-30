import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";

type SpawnedCwdSource = { spawnedCwd?: string | undefined } | undefined | null;

/**
 * spawnedCwd is a filesystem identity: blank counts as absent, but surrounding
 * whitespace names a real directory, so it must survive into runtimeCwd and the
 * persisted transcript header untrimmed. Resolve the first defined source with
 * the same `??` precedence the call sites used before, then apply the non-blank
 * read.
 */
export function resolveSpawnedCwd(...sources: ReadonlyArray<SpawnedCwdSource>): string | undefined {
  const chosen = sources.find((source) => source?.spawnedCwd !== undefined)?.spawnedCwd;
  return readNonBlankString(chosen);
}
