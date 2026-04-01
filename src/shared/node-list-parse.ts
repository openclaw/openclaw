import type { NodeListNode, PairedNode, PairingList, PendingRequest } from "./node-list-types.js";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function parsePairingList(value: unknown): PairingList {
  const obj = asRecord(value);
  const pending = Array.isArray(obj.pending) ? (obj.pending as PendingRequest[]) : [];
  const paired = Array.isArray(obj.paired) ? (obj.paired as PairedNode[]) : [];
  return { pending, paired };
}

export function parseNodeList(value: unknown): NodeListNode[] {
  const obj = asRecord(value);
  return Array.isArray(obj.nodes) ? (obj.nodes as NodeListNode[]) : [];
}
