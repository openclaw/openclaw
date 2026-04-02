import { findLatestFlowForOwnerKey, getFlowById, listFlowsForOwnerKey } from "./flow-registry.js";
import type { FlowRecord } from "./flow-registry.types.js";

function normalizeOwnerKey(ownerKey?: string): string | undefined {
  const trimmed = ownerKey?.trim();
  return trimmed ? trimmed : undefined;
}

function canOwnerAccessFlow(flow: FlowRecord, callerOwnerKey: string): boolean {
  return normalizeOwnerKey(flow.ownerKey) === normalizeOwnerKey(callerOwnerKey);
}

export function getFlowByIdForOwner(params: {
  flowId: string;
  callerOwnerKey: string;
}): FlowRecord | undefined {
  const flow = getFlowById(params.flowId);
  return flow && canOwnerAccessFlow(flow, params.callerOwnerKey) ? flow : undefined;
}

export function listFlowsForOwner(params: { callerOwnerKey: string }): FlowRecord[] {
  const ownerKey = normalizeOwnerKey(params.callerOwnerKey);
  return ownerKey ? listFlowsForOwnerKey(ownerKey) : [];
}

export function findLatestFlowForOwner(params: { callerOwnerKey: string }): FlowRecord | undefined {
  const ownerKey = normalizeOwnerKey(params.callerOwnerKey);
  return ownerKey ? findLatestFlowForOwnerKey(ownerKey) : undefined;
}

export function resolveFlowForLookupTokenForOwner(params: {
  token: string;
  callerOwnerKey: string;
}): FlowRecord | undefined {
  const direct = getFlowByIdForOwner({
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
  return findLatestFlowForOwner({ callerOwnerKey: normalizedCallerOwnerKey });
}
