import { resolveRuntimeProcessEntrypointUrl } from "./runtime-process-url.js";
import { WorkerTaskPool } from "./worker-task-pool.js";

export type ReleaseCandidate = {
  runId: string;
  directory: string;
};
export type ReleaseHolderInspection = { kind: "release-holders"; candidates: ReleaseCandidate[] };
export type ReleaseHolderResults = Record<string, "held" | "unknown" | "clear">;

/** A killed updater's subprocesses may survive. The existing cleanup worker does the blocking
 * OS census, not the Gateway event loop. Only a complete negative observation permits removal. */
export async function inspectReleaseHolders(candidates: ReleaseCandidate[]) {
  const pool = new WorkerTaskPool<ReleaseHolderInspection, ReleaseHolderResults>({
    workerUrl: resolveRuntimeProcessEntrypointUrl("updateAutomaticCleanup"),
    maxWorkers: 1,
    restartOnError: false,
  });
  try {
    return await pool.run({ kind: "release-holders", candidates }, {});
  } finally {
    await pool.close();
  }
}
