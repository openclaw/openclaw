import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  findLatestTaskFlowForOwnerKey,
  getTaskFlowById,
  listTaskFlowsForOwnerKey,
} from "./task-flow-registry.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";

function normalizeOwnerKey(ownerKey?: string): string | undefined {
  return normalizeOptionalString(ownerKey);
}

function canOwnerAccessFlow(flow: TaskFlowRecord, callerOwnerKey: string): boolean {
  return normalizeOwnerKey(flow.ownerKey) === normalizeOwnerKey(callerOwnerKey);
}

export function getTaskFlowByIdForOwner(params: {
  flowId: string;
  callerOwnerKey: string;
}): TaskFlowRecord | undefined {
  const flow = getTaskFlowById(params.flowId);
  return flow && canOwnerAccessFlow(flow, params.callerOwnerKey) ? flow : undefined;
}

export function listTaskFlowsForOwner(params: { callerOwnerKey: string }): TaskFlowRecord[] {
  const ownerKey = normalizeOwnerKey(params.callerOwnerKey);
  return ownerKey ? listTaskFlowsForOwnerKey(ownerKey) : [];
}

export function findLatestTaskFlowForOwner(params: {
  callerOwnerKey: string;
}): TaskFlowRecord | undefined {
  const ownerKey = normalizeOwnerKey(params.callerOwnerKey);
  return ownerKey ? findLatestTaskFlowForOwnerKey(ownerKey) : undefined;
}

export function resolveTaskFlowForLookupTokenForOwner(params: {
  token: string;
  callerOwnerKey: string;
}): TaskFlowRecord | undefined {
  const direct = getTaskFlowByIdForOwner({
    flowId: params.token,
    callerOwnerKey: params.callerOwnerKey,
  });
  if (direct) {
    return direct;
  }
  const normalizedToken = normalizeOwnerKey(params.token);
  const normalizedCallerOwnerKey = normalizeOwnerKey(params.callerOwnerKey);
  if (!normalizedToken || normalizedToken !== normalizedCallerOwnerKey) {
    return undefined;
  }
  return findLatestTaskFlowForOwner({ callerOwnerKey: normalizedCallerOwnerKey });
}
