import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import { normalizeInputProvenance } from "../../sessions/input-provenance.js";
import type { OpenClawAgentReadOnlyDatabase } from "../../state/openclaw-agent-db-readonly-open.js";
import type { HarnessCompletionRecovery } from "./restart-recovery-types.js";
import { everySessionTranscriptUserInputFrom } from "./session-accessor.sqlite-active-events.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import {
  readCurrentProjectionSnapshot,
  type CurrentTranscriptProjection,
} from "./session-accessor.sqlite-projection-read.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import type { HarnessCompletionSourceSnapshot } from "./session-harness-completion-source.types.js";
import { encodeSessionTranscriptWorkerError } from "./session-history-worker-errors.js";
import { SessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import type { SessionEntry } from "./types.js";

/** Exact source lookup is independent of the display tail used to choose recovery policy. */
export function readAdmittedHarnessCompletionInput(params: {
  claim: HarnessCompletionRecovery;
  entry: SessionEntry;
  storePath: string;
  operationalRunId?: string;
  projection?: CurrentTranscriptProjection;
}): boolean {
  const scope = {
    agentId: params.claim.requesterAgentId,
    sessionKey: params.claim.requesterSessionKey,
    sessionId: params.entry.sessionId,
    storePath: params.storePath,
  };
  const priorRunIds = (params.entry.restartRecoveryRuns ?? [])
    .filter((run) => Boolean(run.lifecycleGeneration))
    .map((run) => run.runId);
  const claim = params.claim;
  const allowedRunIds = new Set([params.operationalRunId, ...priorRunIds].filter(Boolean));
  let sourceChecked = false;
  return everySessionTranscriptUserInputFrom(
    scope,
    `${params.claim.sourceRunId}:user`,
    (message) => {
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
          ["agent_harness_task", "agent_harness_completion"].includes(
            provenance.sourceTool ?? "",
          ) &&
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
    },
    params.projection,
  );
}

/** Entry, source input and context version share the admitted reader's SQLite snapshot. */
export function readHarnessCompletionSourceInDatabase(
  database: OpenClawAgentReadOnlyDatabase,
  claim: HarnessCompletionRecovery,
  mode: "admission" | "committed" = "admission",
): HarnessCompletionSourceSnapshot {
  return runSqliteReadSnapshotSync(database.db, () => {
    const entry = readExactSessionEntryRow(
      database,
      claim.requesterSessionKey,
      "full",
      "canonical",
    )?.entry;
    if (
      !entry ||
      (mode === "admission" && entry.restartRecoveryDeliveryRunId === claim.sourceRunId)
    ) {
      return { entry, validInput: true };
    }
    const resolved = {
      agentId: claim.requesterAgentId,
      sessionKey: claim.requesterSessionKey,
      sessionId: entry.sessionId,
      path: database.path,
    };
    try {
      const snapshot = readCurrentProjectionSnapshot(database, resolved, (projection) => ({
        entry,
        validInput: readAdmittedHarnessCompletionInput({
          claim,
          entry,
          storePath: database.path,
          operationalRunId: entry.restartRecoveryDeliveryRunId,
          projection,
        }),
        version: readTranscriptContextVersionInTransaction(database, entry.sessionId),
      }));
      if (snapshot.kind !== "value") {
        throw new SessionTranscriptProjectionUnavailableError(entry.sessionId);
      }
      return snapshot.value;
    } catch (error) {
      const readError = encodeSessionTranscriptWorkerError(error);
      if (!readError) {
        throw error;
      }
      // Main evaluates the earlier live-admission refusal before exposing a later read error.
      return { entry, validInput: false, readError };
    }
  });
}
