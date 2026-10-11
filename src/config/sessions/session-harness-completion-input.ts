import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeInputProvenance } from "../../sessions/input-provenance.js";
import type { HarnessCompletionRecovery } from "./restart-recovery-types.js";
import type { SessionEntry } from "./types.js";

/** Consume the exact source input first, then subsequent active-path user inputs in order. */
export function createHarnessCompletionInputPredicate(params: {
  claim: HarnessCompletionRecovery;
  entry: Pick<SessionEntry, "restartRecoveryRuns">;
  operationalRunId?: string;
}): (message: unknown) => boolean {
  const priorRunIds = (params.entry.restartRecoveryRuns ?? [])
    .filter((run) => Boolean(run.lifecycleGeneration))
    .map((run) => run.runId);
  const claim = params.claim;
  const allowedRunIds = new Set([params.operationalRunId, ...priorRunIds].filter(Boolean));
  let sourceChecked = false;
  return (message) => {
    const record = asOptionalRecord(message);
    const provenance = normalizeInputProvenance(record?.provenance);
    const annotatedRunId = asOptionalRecord(record?.["__openclaw"])?.runId;
    if (!sourceChecked) {
      sourceChecked = true;
      return (
        record?.role === "user" &&
        record.idempotencyKey === `${claim.sourceRunId}:user` &&
        annotatedRunId === claim.sourceRunId &&
        provenance?.kind === "inter_session" &&
        provenance.sourceChannel === "internal" &&
        ["agent_harness_task", "agent_harness_completion"].includes(provenance.sourceTool ?? "") &&
        provenance.sourceSessionKey === claim.taskRunId
      );
    }
    if (record?.role !== "user") {
      return true;
    }
    // The recorder commits the exact input key before native mirroring adds
    // runId. A present annotation must agree with this admitted recovery input.
    const runId =
      typeof record.idempotencyKey === "string"
        ? [...allowedRunIds].find((id) => record.idempotencyKey === `${id}:user`)
        : annotatedRunId;
    return (
      typeof runId === "string" &&
      allowedRunIds.has(runId) &&
      (annotatedRunId == null || annotatedRunId === runId) &&
      provenance?.kind === "internal_system" &&
      provenance.sourceTool === "main_session_restart_recovery" &&
      provenance.sourceSessionKey === claim.requesterSessionKey
    );
  };
}
