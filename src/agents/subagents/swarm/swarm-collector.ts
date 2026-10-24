import { withSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  consumeSwarmStructuredOutput,
  peekSwarmStructuredOutput,
} from "../../tools/structured-output-tool.js";
import { resolveSubagentChildSessionOwner } from "../registry/subagent-child-session-owner.js";
import { ensureCompletionState } from "../registry/subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "../registry/subagent-lifecycle-events.js";
import { updateSubagentArchiveAtMs } from "../registry/subagent-registry-helpers.js";
import type { SwarmCollectorStatus } from "../registry/subagent-registry-read.types.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";

function resolveStatus(
  entry: SubagentRunRecord,
  hasStructuredResult: boolean,
): SwarmCollectorStatus {
  if (entry.endedReason === SUBAGENT_ENDED_REASON_KILLED) {
    return "killed";
  }
  if (entry.execution.outcome?.status === "timeout") {
    return "timeout";
  }
  if (entry.execution.outcome?.status === "ok") {
    return "done";
  }
  // Tool-only structured turns can surface the runner's synthetic completion
  // marker as an error despite having fulfilled the collector contract.
  return hasStructuredResult && entry.execution.outcome?.error === "completed" ? "done" : "failed";
}

export function prepareTerminatedCollectorLaunch(
  entry: SubagentRunRecord,
  endedAt: number,
  error: string,
  getRuntimeConfig: () => OpenClawConfig,
  prepared: { entry: SessionEntry | undefined },
): void {
  entry.swarmLaunchPending = false;
  entry.collectorLaunchCleanupPending = true;
  entry.queuedLaunch = undefined;
  entry.execution = { ...entry.execution, status: "terminal", endedAt };
  entry.completion = {
    required: false,
    resultText:
      entry.execution.outcome?.status === "error"
        ? (entry.execution.outcome.error ?? error)
        : error,
    capturedAt: endedAt,
  };
  updateSwarmCollectorCompletion(entry, getRuntimeConfig(), prepared);
}

/** Freeze the waitable collector record after raw completion capture. */
export function updateSwarmCollectorCompletion(
  entry: SubagentRunRecord,
  cfg: OpenClawConfig,
  prepared: { entry: SessionEntry | undefined },
  reason?: NonNullable<SubagentRunRecord["collectorCompletion"]>["reason"],
): boolean {
  if (!entry.collect) {
    return false;
  }
  const clearedPendingLaunch = entry.swarmLaunchPending === true;
  entry.swarmLaunchPending = false;
  const completion = ensureCompletionState(entry);
  const capturedAtAdded = completion.capturedAt === undefined;
  completion.capturedAt ??= Date.now();
  const archiveDeadlineAdded = updateSubagentArchiveAtMs(entry, cfg);
  if (entry.collectorCompletion) {
    return clearedPendingLaunch || capturedAtAdded || archiveDeadlineAdded;
  }
  const executionCaptured = peekSwarmStructuredOutput(entry.runId);
  const publicCaptured =
    entry.swarmRunId && entry.swarmRunId !== entry.runId
      ? peekSwarmStructuredOutput(entry.swarmRunId)
      : undefined;
  const captured = entry.structuredOutput ?? executionCaptured ?? publicCaptured;
  entry.structuredOutput = undefined;
  const schemaError = entry.outputSchema
    ? (captured?.schemaError ??
      (captured?.structured === undefined ? "structured_output was not called" : undefined))
    : undefined;
  const session = prepared.entry;
  const usage =
    typeof session?.inputTokens === "number" || typeof session?.outputTokens === "number"
      ? {
          inputTokens: session.inputTokens ?? 0,
          outputTokens: session.outputTokens ?? 0,
        }
      : undefined;
  const resolvedStatus = resolveStatus(entry, captured?.structured !== undefined);
  entry.collectorCompletion = {
    status: schemaError && resolvedStatus === "done" ? ("failed" as const) : resolvedStatus,
    ...(captured?.structured !== undefined ? { structured: captured.structured } : {}),
    ...(schemaError ? { schemaError } : {}),
    ...(usage ? { usage } : {}),
    ...(reason ? { reason } : {}),
  };
  return true;
}

/** Prepare optional usage facts without placing session I/O inside a row mutation plan. */
export async function prepareSwarmCollectorCompletion(
  entry: SubagentRunRecord,
  cfg: OpenClawConfig,
  assertCurrent?: () => void,
): Promise<{ entry: SessionEntry | undefined }> {
  if (!entry.collect || entry.collectorCompletion) {
    return { entry: undefined };
  }
  const { agentId, storePath } = resolveSubagentChildSessionOwner(entry, cfg);
  return withSessionEntryReadOnlyInWorker(
    { agentId, storePath, sessionKey: entry.childSessionKey },
    () => assertCurrent?.(),
    async (read) => {
      if (!read.ok) {
        throw read.error;
      }
      return { entry: read.value };
    },
  );
}

/** Ephemeral capture retires only after the durable collector result has published. */
export function clearPublishedSwarmCollectorOutput(entry: SubagentRunRecord): void {
  if (!entry.collectorCompletion) {
    return;
  }
  consumeSwarmStructuredOutput(entry.runId);
  if (entry.swarmRunId && entry.swarmRunId !== entry.runId) {
    consumeSwarmStructuredOutput(entry.swarmRunId);
  }
}
