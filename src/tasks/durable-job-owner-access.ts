import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  getDurableJobById,
  listDurableJobRecords,
  listDurableJobTransitions,
} from "./durable-job-registry.js";
import type { DurableJobRecord, DurableJobTransitionRecord } from "./durable-job-registry.types.js";
import { getTaskFlowById } from "./task-flow-registry.js";

export function getDurableJobByIdForOwner(params: {
  jobId: string;
  callerOwnerKey: string;
}): DurableJobRecord | undefined {
  const job = getDurableJobById(params.jobId);
  return job &&
    normalizeOptionalString(job.ownerSessionKey) === normalizeOptionalString(params.callerOwnerKey)
    ? job
    : undefined;
}

export function listDurableJobsForOwner(params: { callerOwnerKey: string }): DurableJobRecord[] {
  const ownerKey = normalizeOptionalString(params.callerOwnerKey);
  return ownerKey
    ? listDurableJobRecords().filter(
        (job) => normalizeOptionalString(job.ownerSessionKey) === ownerKey,
      )
    : [];
}

export function listDurableJobTransitionsForOwner(params: {
  jobId: string;
  callerOwnerKey: string;
}): DurableJobTransitionRecord[] {
  return getDurableJobByIdForOwner(params) ? listDurableJobTransitions(params.jobId) : [];
}

export function getDurableJobByTaskFlowIdForOwner(params: {
  flowId: string;
  callerOwnerKey: string;
}): DurableJobRecord | undefined {
  const flowId = normalizeOptionalString(params.flowId);
  if (!flowId) {
    return undefined;
  }
  return listDurableJobsForOwner({ callerOwnerKey: params.callerOwnerKey }).find(
    (job) => normalizeOptionalString(job.backing.taskFlowId) === flowId,
  );
}

export function canAttachTaskFlowForDurableJob(params: {
  flowId: string;
  callerOwnerKey: string;
}): boolean {
  const flow = getTaskFlowById(params.flowId);
  return (
    !!flow &&
    normalizeOptionalString(flow.ownerKey) === normalizeOptionalString(params.callerOwnerKey)
  );
}
