import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createSessionWorkStartChangedError } from "../config/sessions/lifecycle.js";
import type { HarnessCompletionRecovery } from "../config/sessions/restart-recovery-types.js";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.js";
import { everySessionTranscriptUserInputFrom } from "../config/sessions/session-accessor.sqlite-active-events.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { normalizeInputProvenance } from "../sessions/input-provenance.js";
import { getTaskByIdForOwner } from "./task-owner-access.js";
import { updateTask } from "./task-registry-mutation.js";
import { getTaskById } from "./task-registry-query.js";
import {
  ensureTaskRegistryReady,
  getTasksByRunId,
  withTaskRegistryMutation,
} from "./task-registry-state.js";
import type { TaskRecord } from "./task-registry.types.js";

function isOwedHarnessTask(
  task: TaskRecord,
): task is TaskRecord & { status: "succeeded" | "failed" } {
  return (
    task.runtime === "subagent" &&
    Boolean(task.taskKind) &&
    (task.status === "succeeded" || task.status === "failed") &&
    task.deliveryStatus === "pending" &&
    Boolean(task.runId) &&
    task.sourceId === task.runId
  );
}

/** Keep source cardinality scoped to the existing run index, including unfinished peers. */
function findSoleHarnessCompletionTask(params: {
  taskRunId: string;
  requesterSessionKey: string;
  requesterAgentId: string;
}): TaskRecord | undefined {
  ensureTaskRegistryReady();
  const matches = getTasksByRunId(params.taskRunId).filter(
    (task) =>
      task.runtime === "subagent" &&
      Boolean(task.taskKind) &&
      task.runId === params.taskRunId &&
      task.requesterSessionKey === params.requesterSessionKey &&
      getTaskByIdForOwner({
        taskId: task.taskId,
        callerOwnerKey: params.requesterSessionKey,
        callerAgentId: params.requesterAgentId,
      }),
  );
  return matches.length === 1 && matches[0] ? getTaskById(matches[0].taskId) : undefined;
}

/** Called by the admitted host run, not by a provenance-only startup scan. */
export function captureHarnessCompletionRecovery(params: {
  agentId: string;
  sessionKey: string;
  entry: SessionEntry;
  runId: string;
  inputProvenance: unknown;
}): HarnessCompletionRecovery | undefined {
  const provenance = normalizeInputProvenance(params.inputProvenance);
  if (
    !params.runId.startsWith("announce:") ||
    provenance?.kind !== "inter_session" ||
    provenance.sourceTool !== "agent_harness_task" ||
    provenance.sourceChannel !== "internal" ||
    !provenance.sourceSessionKey
  ) {
    return undefined;
  }
  const task = findSoleHarnessCompletionTask({
    taskRunId: provenance.sourceSessionKey,
    requesterSessionKey: params.sessionKey,
    requesterAgentId: params.agentId,
  });
  if (!task || !isOwedHarnessTask(task)) {
    return undefined;
  }
  return {
    taskId: task.taskId,
    taskStatus: task.status,
    taskRunId: provenance.sourceSessionKey,
    sourceRunId: params.runId,
    requesterSessionKey: params.sessionKey,
    requesterAgentId: params.agentId,
    sessionId: params.entry.sessionId,
    ...(params.entry.lifecycleRevision
      ? { lifecycleRevision: params.entry.lifecycleRevision }
      : {}),
  };
}

/** A reset, replacement task, cancellation or different owner invalidates the saved join. */
export function getOwedHarnessCompletionTask(
  claim: HarnessCompletionRecovery,
  entry: SessionEntry,
): TaskRecord | undefined {
  if (entry.sessionId !== claim.sessionId || entry.lifecycleRevision !== claim.lifecycleRevision) {
    return undefined;
  }
  const task = findSoleHarnessCompletionTask(claim);
  return task &&
    task.taskId === claim.taskId &&
    task.status === claim.taskStatus &&
    isOwedHarnessTask(task)
    ? task
    : undefined;
}

/** The exact source input must already be in this transcript, before any recovery input. */
function hasAdmittedHarnessCompletionInput(
  claim: HarnessCompletionRecovery,
  messages: readonly unknown[],
  operationalRunId?: string,
  priorRunIds: readonly string[] = [],
): boolean {
  const sources = messages.filter((message) => {
    const record = asOptionalRecord(message);
    const provenance = normalizeInputProvenance(record?.provenance);
    return (
      record?.role === "user" &&
      record.idempotencyKey === `${claim.sourceRunId}:user` &&
      asOptionalRecord(record["__openclaw"])?.runId === claim.sourceRunId &&
      provenance?.kind === "inter_session" &&
      provenance.sourceChannel === "internal" &&
      provenance.sourceTool === "agent_harness_task" &&
      provenance.sourceSessionKey === claim.taskRunId
    );
  });
  if (sources.length !== 1) {
    return false;
  }
  const sourceIndex = messages.indexOf(sources[0]);
  const allowedRunIds = new Set([operationalRunId, ...priorRunIds].filter(Boolean));
  return messages.slice(sourceIndex + 1).every((message) => {
    const record = asOptionalRecord(message);
    if (record?.role !== "user") {
      return true;
    }
    const provenance = normalizeInputProvenance(record.provenance);
    const annotatedRunId = asOptionalRecord(record["__openclaw"])?.runId;
    // The recorder commits the exact input key before native mirroring adds
    // runId. Only this admitted recovery (or an admitted predecessor) may join;
    // a present mirror annotation must agree with the submitted input identity.
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
  });
}

/** Exact source lookup is independent of the display tail used to choose recovery policy. */
export function readAdmittedHarnessCompletionInput(params: {
  claim: HarnessCompletionRecovery;
  entry: SessionEntry;
  storePath: string;
  operationalRunId?: string;
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
  let source: unknown;
  return everySessionTranscriptUserInputFrom(
    scope,
    `${params.claim.sourceRunId}:user`,
    (message) => {
      if (source === undefined) {
        source = message;
        return hasAdmittedHarnessCompletionInput(params.claim, [source]);
      }
      return hasAdmittedHarnessCompletionInput(
        params.claim,
        [source, message],
        params.operationalRunId,
        priorRunIds,
      );
    },
  );
}

/** The existing admitted execution guard rechecks this before execution and delegated effects. */
export function createHarnessCompletionSourceAssertion(params: {
  claim: HarnessCompletionRecovery;
  storePath: string;
  priorAssertion?: () => void;
}): () => void {
  return () => {
    params.priorAssertion?.();
    const current = loadExactSessionEntry({
      agentId: params.claim.requesterAgentId,
      sessionKey: params.claim.requesterSessionKey,
      storePath: params.storePath,
      readConsistency: "latest",
    });
    // The original host claim precedes transcript commit. A recovery attempt
    // already has a committed source and must keep it valid in its read fence.
    if (
      !current ||
      current.sessionKey !== params.claim.requesterSessionKey ||
      !getOwedHarnessCompletionTask(params.claim, current.entry) ||
      (current.entry.restartRecoveryDeliveryRunId !== params.claim.sourceRunId &&
        !readAdmittedHarnessCompletionInput({
          claim: params.claim,
          entry: current.entry,
          storePath: params.storePath,
          operationalRunId: current.entry.restartRecoveryDeliveryRunId,
        }))
    ) {
      throw createSessionWorkStartChangedError(params.claim.requesterSessionKey);
    }
  };
}

/** Session receipt and task live in different stores. Recheck the exact receipt at the task commit. */
export function settleHarnessCompletionTask(params: {
  claim: HarnessCompletionRecovery;
  readCurrentSession: () => SessionEntry | undefined;
  hasQualifyingReceipt: (entry: SessionEntry) => boolean;
}): boolean {
  return withTaskRegistryMutation(
    () => {
      const entry = params.readCurrentSession();
      if (
        !entry ||
        !getOwedHarnessCompletionTask(params.claim, entry) ||
        !params.hasQualifyingReceipt(entry)
      ) {
        return false;
      }
      return updateTask(params.claim.taskId, { deliveryStatus: "delivered" }) !== null;
    },
    () => false,
  );
}
