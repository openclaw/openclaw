import type { GatewaySessionRow } from "../../api/types.ts";
import { projectSessionResultRows } from "./reconcile.ts";
import type {
  SessionCapability,
  SessionConnectionOwner,
  SessionState,
} from "./session-capability.ts";
import { areUiSessionKeysEquivalent } from "./session-key.ts";
import {
  pendingRowIdentity,
  resolvePendingConversation,
  type PendingRowHost,
} from "./session-pending-rows.ts";
import type { createSessionRosterObservations } from "./session-roster-observations.ts";

export type SessionRowLocalPatchHost = Pick<PendingRowHost, "snapshot"> &
  Pick<ReturnType<typeof createSessionRosterObservations>, "copyRow" | "stageManagedResults"> & {
    connection: SessionConnectionOwner;
    readState: () => SessionState;
    publish: (state: SessionState, errorSource?: "session-observer" | "operation") => void;
  };

export function createSessionRowLocalPatch(
  host: SessionRowLocalPatchHost,
): SessionCapability["patchRowLocal"] {
  return (key, patch, target) => {
    const scope = host.connection.capture();
    const normalizedKey = key.trim();
    if (
      !scope ||
      !normalizedKey ||
      (target && (!target.agentId.trim() || !target.sessionId.trim()))
    ) {
      return;
    }
    const snapshot = host.snapshot();
    const owned = target && resolvePendingConversation(snapshot, normalizedKey, target.agentId);
    if (target && !owned) {
      return;
    }
    const project = (row: GatewaySessionRow, agentId?: string | null) => {
      const matches =
        target && owned
          ? row.sessionId === target.sessionId &&
            pendingRowIdentity(snapshot, row, agentId) === owned.identity
          : areUiSessionKeysEquivalent(row.key, normalizedKey);
      return matches ? host.copyRow(row, patch) : row;
    };
    const state = host.readState();
    const result = projectSessionResultRows(
      state.result,
      state.result?.sessions.map((row) => project(row, state.agentId)) ?? [],
    );
    // Unscoped callers retain their primary-only contract. A captured target can
    // update its held descriptor without borrowing primary membership or ownership.
    const staged = target
      ? host.stageManagedResults(
          scope,
          (entry) =>
            projectSessionResultRows(
              entry.snapshot.result,
              entry.snapshot.result?.sessions.map((row) => project(row, entry.snapshot.agentId)) ??
                [],
            ),
          (entry) => ({ row: entry.row ? project(entry.row, entry.target.agentId) : null }),
        )
      : undefined;
    if (!host.connection.isCurrent(scope)) {
      return;
    }
    if (result !== state.result) {
      host.publish({ ...state, result });
    }
    staged?.notify();
  };
}
