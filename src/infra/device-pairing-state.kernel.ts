// Shared snapshot, lock, and normalization owner for device pairing domain modules.
import { normalizeUniqueSingleOrTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import {
  loadDevicePairingStoreState,
  type DevicePairingStoreState,
} from "./device-pairing-store.js";
import { pruneExpiredPending } from "./pairing-files.js";

const DEVICE_PAIRING_PENDING_TTL_MS = 5 * 60 * 1000;

/** Read authoritative rows inside the worker transaction or an admitted migration. */
export function loadDevicePairingStateForMutation(
  nowMs: number,
  baseDir?: string,
): DevicePairingStoreState {
  const state = loadDevicePairingStoreState(baseDir);
  // Node capability requests remain until their approval or reconnect lifecycle resolves them.
  pruneExpiredPending(state.pendingById, nowMs, DEVICE_PAIRING_PENDING_TTL_MS);
  return state;
}

export function resolvePairingRequestExpiry(timestampMs: number): number {
  return timestampMs + DEVICE_PAIRING_PENDING_TTL_MS;
}

export function normalizeDevicePairingRole(role: string | undefined): string | null {
  const trimmed = role?.trim();
  return trimmed ? trimmed : null;
}

/** Merge pairing roles while preserving first-seen order. */
export function mergeDevicePairingRoles(
  ...items: Array<string | string[] | undefined>
): string[] | undefined {
  const roles = [...new Set(items.flatMap(normalizeUniqueSingleOrTrimmedStringList))];
  return roles.length > 0 ? roles : undefined;
}

/** Merge pairing scopes while preserving first-seen order and explicit emptiness. */
export function mergeDevicePairingScopes(
  ...items: Array<string[] | undefined>
): string[] | undefined {
  const lists = items.filter((item) => Array.isArray(item));
  return lists.length > 0
    ? [...new Set(lists.flatMap(normalizeUniqueSingleOrTrimmedStringList))]
    : undefined;
}

/** Preserve only approval scopes owned by one pairing role. */
export function preserveDeviceRoleScopes(role: string, scopes: string[] | undefined): string[] {
  return normalizeUniqueSingleOrTrimmedStringList(scopes).filter((scope) =>
    role === "operator" ? scope.startsWith("operator.") : !scope.startsWith("operator."),
  );
}

export function sameDevicePairingStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

export function resolveRequestedDeviceRoles(input: { role?: string; roles?: string[] }): string[] {
  return mergeDevicePairingRoles(input.roles, input.role) ?? [];
}
