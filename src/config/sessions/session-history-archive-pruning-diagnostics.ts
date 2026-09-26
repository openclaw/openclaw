import { performance } from "node:perf_hooks";
import { getChildLogger } from "../../logging/logger.js";
import type { SqliteSessionArchivePruningDiagnostics } from "./session-accessor.sqlite-contract.js";

function archivePruningLogFields(diagnostics: SqliteSessionArchivePruningDiagnostics) {
  const milliseconds = (value: number | undefined) =>
    value === undefined ? undefined : Math.round(value);
  return {
    trigger: diagnostics.trigger,
    checkpointCalls: diagnostics.checkpointCalls,
    checkpointIncomplete: diagnostics.checkpointIncomplete,
    checkpoint: diagnostics.checkpoint,
    totalBytesBefore: diagnostics.totalBytesBefore,
    totalBytesAfter: diagnostics.totalBytesAfter,
    walBytesBefore: diagnostics.walBytesBefore,
    walBytesAfter: diagnostics.walBytesAfter,
    checkpointMs: milliseconds(diagnostics.checkpointMs),
    checkpointMaxMs: milliseconds(diagnostics.checkpointMaxMs),
    vacuumMs: milliseconds(diagnostics.vacuumMs),
    vacuumPasses: diagnostics.vacuumPasses,
    vacuumPagesRequested: diagnostics.vacuumPagesRequested,
    queryMs: milliseconds(diagnostics.queryMs),
    rowDeletionMs: milliseconds(diagnostics.rowDeletionMs),
    fileRemovalMs: milliseconds(diagnostics.fileRemovalMs),
    removedFiles: diagnostics.removedFiles,
    missingFiles: diagnostics.missingFiles,
    failedRemovals: diagnostics.failedRemovals,
    measurementMs: milliseconds(diagnostics.measurementMs),
    measurements: diagnostics.measurements,
    legacyInventoryMs: milliseconds(diagnostics.legacyInventoryMs),
    completed: diagnostics.completed === true,
  };
}

export async function observeSessionArchivePruning<T>(
  diagnostics: SqliteSessionArchivePruningDiagnostics,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  let failed = true;
  try {
    const result = await run();
    failed = false;
    return result;
  } finally {
    const elapsedMs = performance.now() - startedAt;
    if (failed || elapsedMs >= 1_000) {
      try {
        getChildLogger({ subsystem: "session-sqlite" }).warn(
          failed ? "SQLite session archive pruning failed" : "slow SQLite session archive pruning",
          {
            elapsedMs: Math.round(elapsedMs),
            archivePruning: archivePruningLogFields(diagnostics),
          },
        );
      } catch {
        // Diagnostics cannot replace the pruning result or its original failure.
      }
    }
  }
}

type PruningStage =
  | "queryMs"
  | "rowDeletionMs"
  | "fileRemovalMs"
  | "measurementMs"
  | "legacyInventoryMs";

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
