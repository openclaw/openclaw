import type { NodeListNode, PairedNode, PairingList, PendingRequest } from "./types.js";

export function parsePairingList(value: unknown): PairingList {
  const obj = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const pending = Array.isArray(obj.pending) ? (obj.pending as PendingRequest[]) : [];
  const paired = Array.isArray(obj.paired) ? (obj.paired as PairedNode[]) : [];
  return { pending, paired };
}

export function parseNodeList(value: unknown): NodeListNode[] {
  const obj = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return Array.isArray(obj.nodes) ? (obj.nodes as NodeListNode[]) : [];
}

export function formatPermissions(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const entries = Object.entries(raw as Record<string, unknown>)
    .map(([key, value]) => [String(key).trim(), value === true] as const)
    .filter(([key]) => key.length > 0)
    .toSorted((a, b) => a[0].localeCompare(b[0]));
  if (entries.length === 0) {
    return null;
  }
  const parts = entries.map(([key, granted]) => `${key}=${granted ? "yes" : "no"}`);
  return `[${parts.join(", ")}]`;
}
