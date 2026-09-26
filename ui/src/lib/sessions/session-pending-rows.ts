import type { GatewaySessionRow } from "../../api/types.ts";
import type { SessionPatch, SessionPatchOptions } from "./patch.ts";
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
  notifyPendingChange: () => void;
};

type PendingRowCopyHost = PendingRowHost & {
  copyRow: (row: GatewaySessionRow, patch: Partial<GatewaySessionRow>) => GatewaySessionRow;
};

/** `canonical` is what the Gateway confirmed; `previous` is the value the intent replaced. */
type PendingRowPatch<T> = {
  token: symbol;
  order: number;
  sessionId: string | undefined;
  hasProjectedRow: boolean;
  isCurrent?: () => boolean;
  previous: T;
  next: T;
  canonical: T;
};
export type SessionPinFields = { pinned: boolean; pinnedAt: number | undefined };
type SessionFastModeFields = Pick<GatewaySessionRow, "fastMode" | "effectiveFastMode">;
export const optimisticSessionRowFields = [
  "pinned",
  "pinnedAt",
  "unread",
  "category",
  "thinkingLevel",
  "fastMode",
  "effectiveFastMode",
  "contextWindow",
] as const;
type SessionReadFields = {
  unread: boolean;
  lastReadAt: number | undefined;
  markedUnreadAt: number | undefined;
  agentStatus: GatewaySessionRow["agentStatus"];
};
export type SessionArchiveFields = Pick<
  GatewaySessionRow,
  "archivedAt" | "archivedBy" | "archiveReason"
> & { archived: boolean } & Partial<SessionPinFields>;
export type SessionPatchRowFact = {
  key: string;
  agentId: string;
  sessionId: string;
  updatedAt: number | null;
  readCutoff?: number;
  fields:
    | { category: GatewaySessionRow["category"] }
    | SessionPinFields
    | { pinned: true }
    | SessionReadFields
    | (SessionPinFields & SessionReadFields)
    | SessionArchiveFields
    | Pick<GatewaySessionRow, "fastMode">
    | Pick<
        GatewaySessionRow,
        | "model"
        | "modelProvider"
        | "modelOverrideSource"
        | "agentRuntime"
        | "runtimeSelectionLocked"
        | "contextWindow"
        | "contextWindows"
        | "thinkingLevel"
        | "thinkingLevels"
      >
    | { boardPresentation: GatewaySessionRow["boardPresentation"] }
    | { boardFace: GatewaySessionRow["boardFace"] };
};
export type PendingRowTarget = Readonly<{
  identity: string;
  key: string;
  agentId: string;
  sessionId: string;
}>;

// Presentation may precede a physical row; write admission still requires PendingRowTarget.
type PendingRowPresentationTarget = Omit<PendingRowTarget, "sessionId"> & { sessionId?: string };

export function resolvePendingConversation(
  snapshot: UiSessionDefaultsHost,
  key: string,
  agentId?: string | null,
): Omit<PendingRowTarget, "sessionId"> | null {
  const explicitAgentId = agentId?.trim() ? normalizeAgentId(agentId) : undefined;
  const identity = resolveUiConversationIdentity(snapshot, key, explicitAgentId);
  if (identity.agentId && explicitAgentId && identity.agentId !== explicitAgentId) {
    return null;
  }
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

/** Resolve the physical row from the captured conversation before an operation can queue. */
export function resolvePendingRowTarget(
  host: Pick<PendingRowHost, "findRow">,
  snapshot: UiSessionDefaultsHost,
  conversation: Omit<PendingRowTarget, "sessionId"> | null,
  expectedSessionId?: string,
): PendingRowTarget | null {
  const sessionId = conversation
    ? expectedSessionId !== undefined
      ? expectedSessionId.trim()
      : host
          .findRow(
            (row, sourceAgentId) =>
              pendingRowIdentity(snapshot, row, sourceAgentId) === conversation.identity,
          )
          ?.sessionId?.trim()
    : undefined;
  return conversation && sessionId ? { ...conversation, sessionId } : null;
}

export function capturePendingRowReplacement(
  host: Pick<PendingRowHost, "findRow">,
  snapshot: UiSessionDefaultsHost,
  conversation: Omit<PendingRowTarget, "sessionId"> | null,
  readTarget: () => PendingRowTarget | null,
): () => boolean {
  const readCurrent = () =>
    conversation
      ? host.findRow(
          (row, agentId) => pendingRowIdentity(snapshot, row, agentId) === conversation.identity,
        )
      : undefined;
  const hadRow = Boolean(readCurrent());
  return () => {
    const current = readCurrent();
    const currentId = current?.sessionId?.trim();
    return (hadRow && !current) || Boolean(currentId && currentId !== readTarget()?.sessionId);
  };
}

/** Only an acknowledged predecessor may identify a previously unbound physical row. */
export function resolvePredecessorRowTarget(
  snapshot: UiSessionDefaultsHost,
  conversation: Omit<PendingRowTarget, "sessionId"> | null,
  current: PendingRowTarget | null,
  options: Pick<SessionPatchOptions, "expectedSessionId" | "predecessorReceipt">,
): PendingRowTarget | null {
  if (!conversation || current || options.expectedSessionId !== undefined) {
    return null;
  }
  const receipt = options.predecessorReceipt?.read();
  const sessionId = receipt?.entry.sessionId?.trim();
  return sessionId &&
    receipt &&
    resolvePendingConversation(snapshot, receipt.key, conversation.agentId)?.identity ===
      conversation.identity
    ? { ...conversation, sessionId }
    : null;
}

function createOptimisticRowPatches<T>(
  host: PendingRowHost,
  fields: {
    read: (row: GatewaySessionRow | undefined) => T;
    canonical?: (previous: T, next: T) => T;
    write: (row: GatewaySessionRow, next: T) => GatewaySessionRow;
    observe: (previous: T, row: GatewaySessionRow, names: readonly string[]) => T;
  },
) {
  const pending = new Map<string, PendingRowPatch<T>>();
  let nextOrder = 0;
  const owns = (target: PendingRowPresentationTarget, token: symbol): boolean => {
    const current = pending.get(target.identity);
    return current?.token === token && current.sessionId === target.sessionId;
  };
  const notify = (hasProjectedRow: boolean) => {
    if (!hasProjectedRow) {
      host.notifyPendingChange();
    } else {
      host.redecorateLists();
    }
  };
  const prepare = (
    nextValue: (row: GatewaySessionRow | undefined) => T,
    isCurrent?: () => boolean,
  ) => {
    const token = Symbol("session-row-patch");
    const order = ++nextOrder;
    return (target: PendingRowPresentationTarget): symbol | null => {
      const snapshot = host.snapshot();
      const row = host.findRow(
        (candidate, sourceAgentId) =>
          candidate.sessionId === target.sessionId &&
          pendingRowIdentity(snapshot, candidate, sourceAgentId) === target.identity,
      );
      const current = pending.get(target.identity);
      if (!row && target.sessionId !== undefined) {
        if (current?.token !== token || current.sessionId !== undefined) {
          return null;
        }
        // An ACK binds the existing intent before its row is observed; keep its
        // token, order, and rollback facts until that row can be projected.
        current.sessionId = target.sessionId;
        return token;
      }
      // Identity may arrive after a newer claim has already started projecting.
      if (
        current &&
        (current.sessionId === undefined || current.sessionId === target.sessionId) &&
        current.order > order
      ) {
        return null;
      }
      const next = nextValue(row);
      const previous =
        current && current.sessionId === target.sessionId ? current.previous : fields.read(row);
      const hasProjectedRow = target.sessionId !== undefined;
      pending.set(target.identity, {
        token,
        order,
        sessionId: target.sessionId,
        hasProjectedRow,
        isCurrent,
        previous,
        next,
        canonical: fields.canonical ? fields.canonical(previous, next) : next,
      });
      notify(hasProjectedRow);
      return token;
    };
  };
  return {
    prepare,
    owns,
    read(identity: string): { readonly next: T } | undefined {
      const current = pending.get(identity);
      return current && current.isCurrent?.() !== false ? current : undefined;
    },
    observe(row: GatewaySessionRow, names: readonly string[], identity: string | null): void {
      const current = identity ? pending.get(identity) : undefined;
      if (!current || current.sessionId !== row.sessionId) {
        return;
      }
      // Values come from an admitted source, never the row decorated by this intent.
      current.canonical = fields.observe(current.canonical, row, names);
      current.previous = fields.observe(current.previous, row, names);
    },
    settle(
      target: PendingRowPresentationTarget,
      token: symbol,
      completed: boolean,
      publishOutcome: boolean,
    ): void {
      const current = pending.get(target.identity);
      if (!current || current.token !== token || current.sessionId !== target.sessionId) {
        return;
      }
      if (!current.hasProjectedRow) {
        // An unobserved intent is view-only, even after its target is acknowledged.
        pending.delete(target.identity);
      } else if (publishOutcome) {
        // Decoration writes the intent into the published snapshot, so releasing
        // it cannot restore a value it overwrote. Project the settled truth once
        // more first, or a canonical row that disagrees with the optimistic
        // value stays hidden until an unrelated update arrives.
        current.next = completed ? current.canonical : current.previous;
        // A subscriber starting now inherits the settled rollback baseline.
        current.previous = current.next;
      }
      if (publishOutcome) {
        notify(current.hasProjectedRow);
      }
      // A synchronous subscriber may have started a newer intent during decoration.
      if (pending.get(target.identity) === current) {
        pending.delete(target.identity);
      }
    },
    applyRow(row: GatewaySessionRow, identity: string | null): GatewaySessionRow {
      const patch = identity ? pending.get(identity) : undefined;
      if (!patch || patch.sessionId === undefined || row.sessionId !== patch.sessionId) {
        return row;
      }
      patch.hasProjectedRow = true;
      return fields.write(row, patch.next);
    },
    hasPending: () => pending.size > 0,
    clear: () => pending.clear(),
  };
}

export function createOptimisticRowField<
  Field extends "category" | "unread" | "thinkingLevel" | "contextWindow",
>(host: PendingRowCopyHost, field: Field) {
  return createOptimisticRowPatches(host, {
    read: (row) => row?.[field],
    write: (row, next) => (row[field] === next ? row : host.copyRow(row, { [field]: next })),
    observe: (previous, row, names) => (names.includes(field) ? row[field] : previous),
  });
}

export function createOptimisticPinPatches(host: PendingRowCopyHost) {
  const patches = createOptimisticRowPatches(host, {
    read: (row): SessionPinFields => ({ pinned: row?.pinned === true, pinnedAt: row?.pinnedAt }),
    // Once the Gateway agrees on `pinned`, its own timestamp wins again.
    write: (row, next) => ((row.pinned === true) === next.pinned ? row : host.copyRow(row, next)),
    observe: (previous, row, names) => ({
      pinned: names.includes("pinned") ? row.pinned === true : previous.pinned,
      pinnedAt: names.includes("pinnedAt") ? row.pinnedAt : previous.pinnedAt,
    }),
  });
  return {
    ...patches,
    start(target: PendingRowTarget, pinned: boolean) {
      // Pin order and visibility derive from the same timestamp on the Gateway.
      return patches.prepare((row) =>
        pinned
          ? { pinned: true, pinnedAt: row?.pinnedAt ?? Date.now() }
          : { pinned: false, pinnedAt: undefined },
      )(target);
    },
  };
}

type SessionSettingsPatch = Pick<SessionPatch, "thinkingLevel" | "fastMode" | "contextWindow">;

/** Settings share the row-intent owner; their token group is captured before queued dispatch. */
export function createOptimisticSettingsPatches(host: PendingRowCopyHost) {
  const thinking = createOptimisticRowField(host, "thinkingLevel");
  const fastMode = createOptimisticRowPatches(host, {
    read: (row): SessionFastModeFields => ({
      fastMode: row?.fastMode,
      effectiveFastMode: row?.effectiveFastMode,
    }),
    // An override ACK does not confirm the preview's effective mode.
    canonical: (previous, next) => ({ ...previous, fastMode: next.fastMode }),
    write: (row, next) =>
      row.fastMode === next.fastMode && row.effectiveFastMode === next.effectiveFastMode
        ? row
        : host.copyRow(row, next),
    observe: (previous, row, names) => ({
      fastMode: names.includes("fastMode") ? row.fastMode : previous.fastMode,
      effectiveFastMode: names.includes("effectiveFastMode")
        ? row.effectiveFastMode
        : previous.effectiveFastMode,
    }),
  });
  const contextWindow = createOptimisticRowField(host, "contextWindow");
  return {
    owners: [thinking, fastMode, contextWindow] as const,
    read(identity: string) {
      const thinkingValue = thinking.read(identity);
      const speedValue = fastMode.read(identity);
      const contextValue = contextWindow.read(identity);
      return thinkingValue || speedValue || contextValue
        ? {
            ...(thinkingValue ? { thinkingLevel: thinkingValue.next } : {}),
            ...speedValue?.next,
            ...(contextValue ? { contextWindow: contextValue.next } : {}),
          }
        : undefined;
    },
    prepare(patch: SessionSettingsPatch, isCurrent: () => boolean) {
      const starts: Array<
        readonly [Pick<typeof thinking, "settle" | "owns">, ReturnType<typeof thinking.prepare>]
      > = [];
      if (patch.thinkingLevel !== undefined) {
        starts.push([
          thinking,
          thinking.prepare(() => patch.thinkingLevel?.trim() || undefined, isCurrent),
        ]);
      }
      if (patch.fastMode !== undefined) {
        starts.push([
          fastMode,
          fastMode.prepare(
            () => ({
              fastMode: patch.fastMode ?? undefined,
              effectiveFastMode: patch.fastMode ?? undefined,
            }),
            isCurrent,
          ),
        ]);
      }
      if (patch.contextWindow !== undefined) {
        starts.push([
          contextWindow,
          contextWindow.prepare(() => patch.contextWindow?.trim() || undefined, isCurrent),
        ]);
      }
      return starts.length === 0
        ? null
        : (target: PendingRowPresentationTarget | null) =>
            target ? starts.map(([owner, start]) => [owner, start(target)] as const) : [];
    },
  };
}
