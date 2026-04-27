import { normalizeOptionalString } from "../shared/string-coerce.js";
import { findLatestTaskFlowForOwnerKey, getTaskFlowById, listTaskFlowsForOwnerKey, } from "./task-flow-registry.js";
export function getTaskFlowByIdForOwner(params) {
    const flow = getTaskFlowById(params.flowId);
    return flow &&
        normalizeOptionalString(flow.ownerKey) === normalizeOptionalString(params.callerOwnerKey)
        ? flow
        : undefined;
}
export function listTaskFlowsForOwner(params) {
    const ownerKey = normalizeOptionalString(params.callerOwnerKey);
    return ownerKey ? listTaskFlowsForOwnerKey(ownerKey) : [];
}
export function findLatestTaskFlowForOwner(params) {
    const ownerKey = normalizeOptionalString(params.callerOwnerKey);
    return ownerKey ? findLatestTaskFlowForOwnerKey(ownerKey) : undefined;
}
export function resolveTaskFlowForLookupTokenForOwner(params) {
    const direct = getTaskFlowByIdForOwner({
        flowId: params.token,
        callerOwnerKey: params.callerOwnerKey,
    });
    if (direct) {
        return direct;
    }
    const normalizedToken = normalizeOptionalString(params.token);
    const normalizedCallerOwnerKey = normalizeOptionalString(params.callerOwnerKey);
    if (!normalizedToken || normalizedToken !== normalizedCallerOwnerKey) {
        return undefined;
    }
    return findLatestTaskFlowForOwner({ callerOwnerKey: normalizedCallerOwnerKey });
}
