import { summarizeSpawnError, type runSpawnPipeline } from "../../spawn-pipeline.js";
import type { SpawnSubagentResult } from "./subagent-spawn-contract.js";

export function buildSubagentSpawnFailureResult(
  result: Extract<Awaited<ReturnType<typeof runSpawnPipeline>>, { ok: false }>,
  options: {
    childSessionKey: string;
    fallbackRunId: string;
    acceptedRunCleanupError?: string;
  },
): SpawnSubagentResult {
  const { phase, error } = result;
  const runId = result.runId ?? options.fallbackRunId;
  const spawnStatus =
    error && typeof error === "object" && "spawnStatus" in error ? error.spawnStatus : undefined;
  return {
    status: spawnStatus === "forbidden" ? "forbidden" : "error",
    error: [
      phase === "register" && spawnStatus !== "forbidden"
        ? `Failed to register subagent run: ${summarizeSpawnError(error)}`
        : summarizeSpawnError(error),
      options.acceptedRunCleanupError,
    ]
      .filter(Boolean)
      .join(" "),
    childSessionKey: options.childSessionKey,
    ...(phase === "initialize" ? {} : { runId }),
  };
}
