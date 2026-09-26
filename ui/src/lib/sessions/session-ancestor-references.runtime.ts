import type { GatewaySessionRow } from "../../api/types.ts";
import { isShallowEqualSessionRow } from "./session-row-equality.ts";
import {
  isSessionRowOutsideResultScope,
  matchesExistingSession,
  type SessionChangedEventInfo,
  type SessionChangedRowProjection,
  type SessionChangedRowResult,
  type SessionReconcileOptions,
} from "./session-row-reconcile.ts";

// Copies and local edits cannot certify references by copying a wire revision.
const revisions = new WeakMap<GatewaySessionRow, string>();

export function remember(row: GatewaySessionRow, offered: GatewaySessionRow, revision: string) {
  if (isShallowEqualSessionRow(row, offered)) {
    revisions.set(row, revision);
  }
}

export function reconcile(
  existing: GatewaySessionRow | undefined,
  info: SessionChangedEventInfo,
  source: Record<string, unknown>,
  options: SessionReconcileOptions,
  project?: SessionChangedRowProjection,
): SessionChangedRowResult {
  const { key } = info;
  if (
    !existing ||
    !info.sessionId ||
    existing.sessionId !== info.sessionId ||
    typeof source.revision !== "string" ||
    revisions.get(existing) !== source.revision ||
    info.snapshotAt === undefined ||
    !matchesExistingSession(existing, key, info.agentId) ||
    isSessionRowOutsideResultScope(existing, options)
  ) {
    return { applied: false, key, row: existing };
  }
  const retained = {
    ...existing,
    snapshotAt: Math.max(existing.snapshotAt ?? 0, info.snapshotAt),
  };
  const row = project?.(retained, existing, Object.keys(existing), info) ?? retained;
  remember(row, retained, source.revision);
  return { applied: true, key, row, admittedRow: row, reconciled: true };
}
