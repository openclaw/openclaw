import type { GatewaySessionRow } from "../../api/types.ts";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiConversationIdentity,
  type UiSessionDefaultsHost,
} from "./session-key.ts";

export type PendingRowHost = {
  snapshot: () => UiSessionDefaultsHost;
  findRow: (
    matches: (row: GatewaySessionRow, agentId?: string | null) => boolean,
  ) => GatewaySessionRow | undefined;
  redecorateLists: () => void;
};

/** `canonical` is what the Gateway confirmed; `previous` is the value the intent replaced. */
type PendingRowPatch<T> = {
  token: symbol;
  sessionId: string;
  previous: T;
  next: T;
  canonical: T;
};
export type SessionPinFields = { pinned: boolean; pinnedAt: number | undefined };
type SessionReadFields = {
  unread: boolean;
  lastReadAt: number | undefined;
  markedUnreadAt: number | undefined;
};
export type SessionPatchRowFact = {
  key: string;
  agentId: string;
  sessionId: string;
  updatedAt: number | null;
  fields: SessionPinFields | SessionReadFields | (SessionPinFields & SessionReadFields);
};
export type PendingRowTarget = Readonly<{
  identity: string;
  key: string;
  agentId: string;
  sessionId: string;
}>;

export function resolvePendingConversation(
  snapshot: UiSessionDefaultsHost,
  key: string,
  agentId?: string | null,
): Omit<PendingRowTarget, "sessionId"> | null {
  const explicitAgentId = agentId?.trim() ? normalizeAgentId(agentId) : undefined;
  const parsedAgentId = parseAgentSessionKey(key)?.agentId;
  if (parsedAgentId && explicitAgentId && normalizeAgentId(parsedAgentId) !== explicitAgentId) {
    return null;
  }
  const identity = resolveUiConversationIdentity(snapshot, key, explicitAgentId);
  const ownerAgentId = identity.agentId ?? explicitAgentId;
  return identity.sessionKey && ownerAgentId
    ? {
        identity: JSON.stringify([identity.sessionKey, ownerAgentId]),
        key: identity.sessionKey,
        agentId: ownerAgentId,
      }
    : null;
}

export function pendingRowIdentity(
  snapshot: UiSessionDefaultsHost,
  row: GatewaySessionRow,
  sourceAgentId?: string | null,
): string | null {
  const ownerAgentId =
    row.agentId?.trim() || parseAgentSessionKey(row.key)?.agentId || sourceAgentId;
  // A source without an owner cannot borrow the currently selected destination.
  if (!ownerAgentId?.trim()) {
    return null;
  }
  return resolvePendingConversation(snapshot, row.key, ownerAgentId)?.identity ?? null;
}

export function createOptimisticRowPatches<T>(
  host: PendingRowHost,
  fields: {
    read: (row: GatewaySessionRow) => T;
    write: (row: GatewaySessionRow, next: T) => GatewaySessionRow;
    observe: (previous: T, row: GatewaySessionRow, names: readonly string[]) => T;
  },
) {
  const pending = new Map<string, PendingRowPatch<T>>();
  return {
    start(target: PendingRowTarget, nextValue: (row: GatewaySessionRow) => T): symbol | null {
      const snapshot = host.snapshot();
      const row = host.findRow(
        (candidate, sourceAgentId) =>
          candidate.sessionId === target.sessionId &&
          pendingRowIdentity(snapshot, candidate, sourceAgentId) === target.identity,
      );
      if (!row) {
        return null;
      }
      const token = Symbol("session-row-patch");
      const current = pending.get(target.identity);
      const next = nextValue(row);
      pending.set(target.identity, {
        token,
        sessionId: target.sessionId,
        previous: current?.sessionId === target.sessionId ? current.previous : fields.read(row),
        next,
        canonical: next,
      });
      host.redecorateLists();
      return token;
    },
    observe(row: GatewaySessionRow, names: readonly string[], sourceAgentId?: string | null): void {
      const identity = pendingRowIdentity(host.snapshot(), row, sourceAgentId);
      const current = identity ? pending.get(identity) : undefined;
      if (!current || current.sessionId !== row.sessionId) {
        return;
      }
      // Values come from an admitted source, never the row decorated by this intent.
      current.canonical = fields.observe(current.canonical, row, names);
      current.previous = fields.observe(current.previous, row, names);
    },
    settle(
      target: PendingRowTarget,
      token: symbol,
      completed: boolean,
      connectionCurrent: boolean,
    ): void {
      const current = pending.get(target.identity);
      if (!current || current.token !== token || current.sessionId !== target.sessionId) {
        return;
      }
      if (connectionCurrent) {
        // Decoration writes the intent into the published snapshot, so releasing
        // it cannot restore a value it overwrote. Project the settled truth once
        // more first, or a canonical row that disagrees with the optimistic
        // value stays hidden until an unrelated update arrives.
        current.next = completed ? current.canonical : current.previous;
        // A subscriber starting now inherits the settled rollback baseline.
        current.previous = current.next;
        host.redecorateLists();
      }
      // A synchronous subscriber may have started a newer intent during decoration.
      if (pending.get(target.identity) === current) {
        pending.delete(target.identity);
      }
    },
    applyRow(row: GatewaySessionRow, sourceAgentId?: string | null): GatewaySessionRow {
      if (pending.size === 0) {
        return row;
      }
      const identity = pendingRowIdentity(host.snapshot(), row, sourceAgentId);
      const patch = identity ? pending.get(identity) : undefined;
      return patch && row.sessionId === patch.sessionId ? fields.write(row, patch.next) : row;
    },
    hasPending: () => pending.size > 0,
    clear: () => pending.clear(),
  };
}
