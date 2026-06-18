// Node list parsing helpers normalize node inventory records from CLI output.
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { NodeListNode, PairedNode, PairingList, PendingRequest } from "./node-list-types.js";

// pending/paired rows are blind-cast from a permissive pairing file, so any scalar can be
// non-string. CLI renderers call `.trim()`/`sanitizeTerminalText` on them (these rows bypass
// the gateway node catalog), so normalize at this shared parse boundary to keep every
// consumer crash-safe.
function coerceRequiredString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizePendingRequest(row: PendingRequest): PendingRequest {
  return {
    ...row,
    requestId: coerceRequiredString(row.requestId),
    nodeId: coerceRequiredString(row.nodeId),
    displayName: normalizeOptionalString(row.displayName),
    platform: normalizeOptionalString(row.platform),
    version: normalizeOptionalString(row.version),
    coreVersion: normalizeOptionalString(row.coreVersion),
    uiVersion: normalizeOptionalString(row.uiVersion),
    remoteIp: normalizeOptionalString(row.remoteIp),
  };
}

function normalizePairedNode(row: PairedNode): PairedNode {
  return {
    ...row,
    nodeId: coerceRequiredString(row.nodeId),
    token: normalizeOptionalString(row.token),
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
    ? (obj.pending as PendingRequest[]).map(normalizePendingRequest)
    : [];
  const paired = Array.isArray(obj.paired)
    ? (obj.paired as PairedNode[]).map(normalizePairedNode)
    : [];
  return { pending, paired };
}

/** Extracts the nodes array from a node.list response, treating malformed payloads as empty. */
export function parseNodeList(value: unknown): NodeListNode[] {
  const obj = asRecord(value);
  return Array.isArray(obj.nodes) ? (obj.nodes as NodeListNode[]) : [];
}
