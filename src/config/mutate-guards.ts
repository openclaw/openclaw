import { getPublishedConfigRuntimeEnvState } from "./config-env-vars.js";
import { resolveConfigSnapshotHash } from "./io.js";
import { ConfigMutationConflictError } from "./mutation-conflict.js";
import type { ConfigFileSnapshot } from "./types.js";
export function assertManagedRuntimeEnvGeneration(generation: number): void {
  if (getPublishedConfigRuntimeEnvState().generation !== generation) {
    throw new ConfigMutationConflictError(
      "active config environment changed while preparing write",
    );
  }
}

export function assertBaseHashMatches(
  snapshot: ConfigFileSnapshot,
  expectedHash?: string,
): string | null {
  const currentHash = resolveConfigSnapshotHash(snapshot) ?? null;
  if (expectedHash !== undefined && expectedHash !== currentHash) {
    throw new ConfigMutationConflictError("config changed since last load");
  }
  return currentHash;
}

export function assertExpectedConfigPathMatches(
  snapshot: ConfigFileSnapshot,
  expectedConfigPath?: string,
): void {
  if (expectedConfigPath !== undefined && expectedConfigPath !== snapshot.path) {
    throw new ConfigMutationConflictError("config path changed since last load", {
      retryable: false,
    });
  }
}
