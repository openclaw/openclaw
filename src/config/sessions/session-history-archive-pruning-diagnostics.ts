import { performance } from "node:perf_hooks";
import type { SqliteSessionArchivePruningDiagnostics } from "./session-accessor.sqlite-contract.js";

type PruningStage =
  | "vacuumMs"
  | "queryMs"
  | "rowDeletionMs"
  | "fileRemovalMs"
  | "measurementMs"
  | "legacyInventoryMs";

export function timeArchivePruningSync<T>(
  diagnostics: SqliteSessionArchivePruningDiagnostics | undefined,
  stage: PruningStage,
  operation: () => T,
): T {
  if (!diagnostics) {
    return operation();
  }
  const startedAt = performance.now();
  try {
    return operation();
  } finally {
    diagnostics[stage] = (diagnostics[stage] ?? 0) + performance.now() - startedAt;
  }
}

export async function timeArchivePruningAsync<T>(
  diagnostics: SqliteSessionArchivePruningDiagnostics | undefined,
  stage: PruningStage,
  operation: () => Promise<T>,
): Promise<T> {
  if (!diagnostics) {
    return await operation();
  }
  if (stage === "measurementMs") {
    diagnostics.measurements = (diagnostics.measurements ?? 0) + 1;
  }
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    diagnostics[stage] = (diagnostics[stage] ?? 0) + performance.now() - startedAt;
  }
}
