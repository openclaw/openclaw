import { asRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { NodeListNode, PairedNode, PairingList, PendingRequest } from "./node-list-types.js";

export const NODE_WORKER_CAPACITY_MAX = 1_024;

export function availableWorkerSlots(capacity: NonNullable<NodeListNode["workerSlots"]>): number {
  return capacity.available + (capacity.reclaimableIdle ?? 0);
}

export function parseWorkerSlotSummary(
  value: unknown,
): NonNullable<NodeListNode["workerSlots"]> | null {
  if (!isRecord(value)) {
    return null;
  }
  const keys = Object.keys(value);
  const { total, available, reclaimableIdle } = value;
  return keys.every((key) => key === "total" || key === "available" || key === "reclaimableIdle") &&
    keys.includes("total") &&
    keys.includes("available") &&
    typeof total === "number" &&
    typeof available === "number" &&
    Number.isSafeInteger(total) &&
    Number.isSafeInteger(available) &&
    total >= 1 &&
    total <= NODE_WORKER_CAPACITY_MAX &&
    available >= 0 &&
    available <= total &&
    (reclaimableIdle === undefined ||
      (typeof reclaimableIdle === "number" &&
        Number.isSafeInteger(reclaimableIdle) &&
        reclaimableIdle >= 0 &&
        reclaimableIdle <= Math.min(2, total - available)))
    ? { total, available, ...(reclaimableIdle === undefined ? {} : { reclaimableIdle }) }
    : null;
}

// pending/paired rows are blind-cast from a permissive pairing file, so any scalar can be
// non-string. CLI renderers call `.trim()`/`sanitizeTerminalText` on them (these rows bypass
// the gateway node catalog), so normalize at this shared parse boundary to keep every
// consumer crash-safe.
// A pending/paired row needs an addressable string id to be approved, keyed, or rendered. A
// non-string required id drops the row entirely rather than becoming an empty-string sentinel that
// downstream consumers would treat as a real id.
function normalizePendingRequest(row: PendingRequest): PendingRequest | null {
  const requestId = normalizeOptionalString(row.requestId);
  const nodeId = normalizeOptionalString(row.nodeId);
  if (requestId === undefined || nodeId === undefined) {
    return null;
  }
  return {
    ...row,
    requestId,
    nodeId,
    displayName: normalizeOptionalString(row.displayName),
    platform: normalizeOptionalString(row.platform),
    version: normalizeOptionalString(row.version),
    coreVersion: normalizeOptionalString(row.coreVersion),
    uiVersion: normalizeOptionalString(row.uiVersion),
    remoteIp: normalizeOptionalString(row.remoteIp),
  };
}

function normalizePairedNode(row: PairedNode): PairedNode | null {
  const nodeId = normalizeOptionalString(row.nodeId);
  if (nodeId === undefined) {
    return null;
  }
  return {
    ...row,
    nodeId,
    displayName: normalizeOptionalString(row.displayName),
    platform: normalizeOptionalString(row.platform),
    version: normalizeOptionalString(row.version),
    coreVersion: normalizeOptionalString(row.coreVersion),
    uiVersion: normalizeOptionalString(row.uiVersion),
    remoteIp: normalizeOptionalString(row.remoteIp),
    lastSeenReason: normalizeOptionalString(row.lastSeenReason),
  };
}

/** Extracts pending and paired node arrays from permissive node.pair.list payloads. */
export function parsePairingList(value: unknown): PairingList {
  const obj = asRecord(value);
  const pending = Array.isArray(obj.pending)
    ? (obj.pending as PendingRequest[])
        .map(normalizePendingRequest)
        .filter((row): row is PendingRequest => row !== null)
    : [];
  const paired = Array.isArray(obj.paired)
    ? (obj.paired as PairedNode[])
        .map(normalizePairedNode)
        .filter((row): row is PairedNode => row !== null)
    : [];
  return { pending, paired };
}

/** Extracts the nodes array from a node.list response, treating malformed payloads as empty. */
export function parseNodeList(value: unknown): NodeListNode[] {
  const obj = asRecord(value);
  return Array.isArray(obj.nodes) ? (obj.nodes as NodeListNode[]) : [];
}
