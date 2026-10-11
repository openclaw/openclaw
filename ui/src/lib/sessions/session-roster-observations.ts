import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { createSessionEventRefreshCoordinator } from "./event-refresh-coordinator.ts";
import { projectSessionResultRows, reconcileRosterPresentationMetadata } from "./reconcile.ts";
import type {
  SessionConnectionOwner,
  SessionConnectionScope,
  SessionRowTarget,
  SessionRowEventListener,
  SessionRowListener,
} from "./session-capability.ts";
import { createSessionDescribeReads } from "./session-describe.ts";
import {
  createSessionEventDelivery,
  type SessionEventDelivery,
} from "./session-event-observation.ts";
import {
  areUiSessionKeysEquivalent,
  normalizeAgentId,
  parseAgentSessionKey,
} from "./session-key.ts";
import type { ObservedSessionList } from "./session-list-query.ts";
import { createSessionRosterProjection } from "./session-roster-projection.ts";
import { createSessionRowProvenance } from "./session-row-provenance.ts";
import { matchesExistingSession, type SessionChangedRowResult } from "./session-row-reconcile.ts";
import { createSessionRunTerminalStaging } from "./session-run-terminal.ts";

type RegisteredRow = {
  target: SessionRowTarget;
  scope: SessionConnectionScope | null;
  snapshot: {
    row: GatewaySessionRow | null;
    sessionId: string | null;
    hasObserved: boolean;
    retired: boolean;
  };
  listener: SessionRowListener;
  onInvalidate?: (reason?: string) => void;
  onEvent?: SessionRowEventListener;
  isValid: (sessionId: string) => boolean;
  decorate: (row: GatewaySessionRow) => GatewaySessionRow | null;
};
type RowProjection = (entry: { target: SessionRowTarget; row: GatewaySessionRow | null }) => {
  row: GatewaySessionRow | null;
  invalidate?: "now" | "later";
  retire?: boolean;
  eventResult?: SessionChangedRowResult;
};

/** Shared row presentation; lists retain their own membership. */
export function createSessionRosterObservations(
  host: {
    connection: SessionConnectionOwner;
    observerError: () => string | null;
    readState: () => {
      result: SessionsListResult | null;
      agentId: string | null;
      resultCached?: boolean;
    };
    decorate: (
      result: SessionsListResult | null,
      owner: ObservedSessionList,
    ) => SessionsListResult | null;
  },
  lists: ReadonlyMap<string, ObservedSessionList>,
) {
  const provenance = createSessionRowProvenance();
  const { owner, identity, inheritRow, mergeRow, rowRevision, observeReadRow } = provenance;
  const registeredRows = new Set<RegisteredRow>();
  const invalidatedRows = new Map<RegisteredRow, string | undefined>();
  const refresh = createSessionEventRefreshCoordinator({
    active: true,
    refresh: async () => {
      const pending = [...invalidatedRows];
      invalidatedRows.clear();
      for (const [entry, reason] of pending) {
        if (isCurrent(entry)) {
          entry.onInvalidate?.(reason);
        }
      }
    },
  });
  const isAttached = (entry: RegisteredRow) =>
    registeredRows.has(entry) && entry.scope !== null && host.connection.isCurrent(entry.scope);
  const isCurrent = (entry: RegisteredRow) =>
    isAttached(entry) &&
    !entry.snapshot.retired &&
    (entry.snapshot.sessionId === null || entry.isValid(entry.snapshot.sessionId));
  const matchesTarget = (row: GatewaySessionRow, target: SessionRowTarget) => {
    const parsedAgent = parseAgentSessionKey(row.key)?.agentId;
    return (
      Boolean(row.sessionId?.trim()) &&
      areUiSessionKeysEquivalent(row.key, target.key) &&
      owner(row, target.agentId) === normalizeAgentId(target.agentId) &&
      (!parsedAgent ||
        !row.agentId ||
        normalizeAgentId(row.agentId) === normalizeAgentId(parsedAgent))
    );
  };
  const acceptsRow = (entry: RegisteredRow, row: GatewaySessionRow) =>
    isCurrent(entry) &&
    matchesTarget(row, entry.target) &&
    Boolean(row.sessionId && entry.isValid(row.sessionId)) &&
    (entry.snapshot.sessionId === null || entry.snapshot.sessionId === row.sessionId);
  const captureHeldRows = (sessionIds?: ReadonlySet<string | undefined>) => {
    const state = host.readState();
    const primaryRows = indexRows(state.result?.sessions ?? [], state.agentId, sessionIds);
    const observedRows = new Map<string, GatewaySessionRow[]>();
    const append = (row: GatewaySessionRow, agentId?: string | null) => {
      if (
        (sessionIds && !sessionIds.has(row.sessionId)) ||
        (state.resultCached && rowRevision(row) === 0)
      ) {
        return;
      }
      const key = identity(row, agentId);
      if (key) {
        const rows = observedRows.get(key) ?? [];
        rows.push(row);
        observedRows.set(key, rows);
      }
    };
    for (const entry of lists.values()) {
      if (entry.connectionEpoch === host.connection.capture()?.epoch) {
        for (const row of entry.snapshot.result?.sessions ?? []) {
          append(row, entry.snapshot.agentId);
        }
      }
    }
    for (const entry of registeredRows) {
      if (isCurrent(entry) && entry.snapshot.row) {
        append(entry.snapshot.row, entry.target.agentId);
      }
    }
    return { state, primaryRows, observedRows };
  };
  const { indexRows, merge, prepareProjection, projectFields, currentRow } =
    createSessionRosterProjection(provenance, captureHeldRows);
  const captureEventDelivery = createSessionEventDelivery(
    registeredRows,
    host.connection,
    isAttached,
    isCurrent,
  );
  const stageManagedResults = (
    scope: SessionConnectionScope | null,
    project: (entry: ObservedSessionList) => SessionsListResult | null,
    projectRow?: RowProjection,
    event?: SessionEventDelivery<RegisteredRow>,
    reason?: string,
  ) => {
    if (!scope || !host.connection.isCurrent(scope)) {
      return { changed: false, notify: () => {} };
    }
    const changedLists: ObservedSessionList[] = [];
    const changedRows: RegisteredRow[] = [];
    const invalidateNow: RegisteredRow[] = [];
    for (const entry of lists.values()) {
      if (entry.connectionEpoch !== scope.epoch) {
        continue;
      }
      const result = host.decorate(project(entry), entry);
      if (result !== entry.snapshot.result) {
        entry.snapshot = { ...entry.snapshot, result };
        changedLists.push(entry);
      }
    }
    for (const entry of registeredRows) {
      if (!isAttached(entry)) {
        continue;
      }
      const projected = projectRow?.({ target: entry.target, row: entry.snapshot.row }) ?? {
        row: entry.snapshot.row,
      };
      const replacement =
        projected.row &&
        entry.snapshot.sessionId !== null &&
        projected.row.sessionId !== entry.snapshot.sessionId &&
        matchesTarget(projected.row, entry.target) &&
        (projected.row.updatedAt ?? 0) >= (entry.snapshot.row?.updatedAt ?? 0);
      if (projected.retire || replacement) {
        entry.snapshot = { ...entry.snapshot, row: null, retired: true };
        invalidatedRows.delete(entry);
        changedRows.push(entry);
        continue;
      }
      if (!isCurrent(entry)) {
        continue;
      }
      if (projected.invalidate && entry.onInvalidate) {
        if (projected.invalidate === "later") {
          invalidatedRows.set(entry, reason);
          refresh.schedule();
        } else {
          invalidateNow.push(entry);
        }
      }
      if (projected.row && !acceptsRow(entry, projected.row)) {
        continue;
      }
      const row = projected.row ? entry.decorate(projected.row) : null;
      if (row && !matchesTarget(row, entry.target)) {
        continue;
      }
      if (row !== entry.snapshot.row || projected.eventResult?.deletedKey) {
        entry.snapshot = {
          row,
          sessionId: entry.snapshot.sessionId ?? row?.sessionId ?? null,
          hasObserved:
            entry.snapshot.hasObserved ||
            row !== null ||
            Boolean(projected.eventResult?.deletedKey),
          retired: Boolean(projected.eventResult?.deletedKey),
        };
        changedRows.push(entry);
      }
      if (projected.eventResult) {
        event?.results.set(entry, projected.eventResult);
      }
    }
    return {
      changed: changedLists.length > 0 || changedRows.length > 0,
      notify() {
        if (!host.connection.isCurrent(scope)) {
          return;
        }
        for (const entry of changedLists) {
          for (const listener of entry.listeners) {
            listener(entry.snapshot);
          }
        }
        for (const entry of changedRows) {
          if (isAttached(entry)) {
            if (entry.snapshot.retired && event) {
              entry.listener(entry.snapshot.row, { eventPending: true });
            } else {
              entry.listener(entry.snapshot.row);
            }
          }
        }
        for (const entry of invalidateNow) {
          if (isCurrent(entry)) {
            entry.onInvalidate?.(reason);
          }
        }
      },
    };
  };
  const stageObservedRows = (
    rows: readonly GatewaySessionRow[],
    scope: SessionConnectionScope | null,
    agentId?: string | null,
    issuedRevision?: number,
    managed = true,
  ) => {
    for (const row of rows) {
      if (issuedRevision !== undefined) {
        observeReadRow(row, issuedRevision, agentId);
      }
    }
    const offered = indexRows(rows, agentId);
    return stageManagedResults(
      scope,
      (entry) => merge(entry.snapshot.result, managed ? rows : [], entry.snapshot.agentId, agentId),
      (entry) => {
        const matching = [...offered.values()].find((row) => matchesTarget(row, entry.target));
        return {
          row: matching
            ? entry.row && entry.row.sessionId === matching.sessionId
              ? mergeRow(entry.row, matching, entry.target.agentId)
              : matching
            : entry.row,
        };
      },
    ).notify;
  };
  const publishedRow = (matches: (row: GatewaySessionRow, agentId?: string | null) => boolean) => {
    const state = host.readState();
    const primary = state.result?.sessions.find((row) => matches(row, state.agentId));
    if (primary) {
      return primary;
    }
    for (const entry of lists.values()) {
      const row = entry.snapshot.result?.sessions.find((candidate) =>
        matches(candidate, entry.scope.agentId),
      );
      if (row) {
        return row;
      }
    }
    for (const entry of registeredRows) {
      if (
        isCurrent(entry) &&
        entry.snapshot.row &&
        matches(entry.snapshot.row, entry.target.agentId)
      ) {
        return entry.snapshot.row;
      }
    }
    return undefined;
  };
  const descriptions = createSessionDescribeReads({
    connection: host.connection,
    canReuse: () => host.observerError() === null,
    currentRow: (params) =>
      publishedRow((row, agentId) =>
        matchesExistingSession(row, params.key, params.agentId ?? agentId ?? null),
      ),
  });
  const observations = {
    descriptions,
    reset() {
      provenance.reset();
      registeredRows.clear();
      invalidatedRows.clear();
      refresh.reset();
      descriptions.clear();
    },
    registerRow(
      target: SessionRowTarget,
      listener: SessionRowListener,
      options: Pick<RegisteredRow, "isValid" | "decorate" | "onInvalidate" | "onEvent">,
    ) {
      const entry: RegisteredRow = {
        target,
        scope: host.connection.capture(),
        listener,
        ...options,
        snapshot: { row: null, sessionId: null, hasObserved: false, retired: false },
      };
      registeredRows.add(entry);
      return {
        current: () => (isCurrent(entry) ? entry.snapshot.row : null),
        sessionId: () => entry.snapshot.sessionId,
        hasObserved: () => entry.snapshot.hasObserved,
        isCurrent: () => isCurrent(entry),
        acceptsRead: (row: GatewaySessionRow) => acceptsRow(entry, row),
        clear: () => {
          entry.snapshot = { ...entry.snapshot, row: null, hasObserved: true };
          return () => {
            if (isCurrent(entry)) {
              listener(null);
            }
          };
        },
        dispose: () => {
          registeredRows.delete(entry);
          invalidatedRows.delete(entry);
        },
      };
    },
    inheritRow,
    mergeRow,
    currentRow,
    publishedRow,
    observedRow: (key: string, agentId?: string | null) =>
      publishedRow(
        (row, ownerAgentId) =>
          provenance.hasObservation(row) &&
          matchesExistingSession(row, key, agentId ?? ownerAgentId ?? null),
      ),
    mergeRows: merge,
    projectFields,
    prepareProjection,
    projectRows: (rows: readonly GatewaySessionRow[]) => prepareProjection(rows).projectRows(rows),
    stageObservedRows,
    stageManagedResults,
    captureEventDelivery,
    rowRevision,
    hasLiveObservation: (row: GatewaySessionRow) =>
      host.connection.capture() !== null && provenance.hasObservation(row),
    bindOwner: (result: SessionsListResult | null, agentId?: string | null) => {
      for (const row of result?.sessions ?? []) {
        provenance.bindOwner(row, agentId);
      }
    },
    observeReadRow,
    observeClears: provenance.observeClears,
    observeReadRows: (
      rows: readonly GatewaySessionRow[],
      revision: number,
      agentId?: string | null,
    ) => {
      for (const row of rows) {
        observeReadRow(row, revision, agentId);
      }
    },
    stageRunTerminal: createSessionRunTerminalStaging({
      readState: host.readState,
      prepareProjection,
      provenance,
      stage: stageManagedResults,
    }),
    copyRow: (row: GatewaySessionRow, patch: Partial<GatewaySessionRow>) =>
      inheritRow({ ...row, ...patch }, row),
    captureReconciliation(revision: number) {
      const scope = host.connection.capture();
      return {
        scope,
        revision,
        observe: (row: GatewaySessionRow, agentId?: string | null) =>
          observeReadRow(row, revision, agentId),
        isCurrent: () => scope !== null && host.connection.isCurrent(scope),
        stage: (row: GatewaySessionRow, agentId?: string | null) =>
          stageObservedRows([row], scope, agentId, revision),
      };
    },
    accept(
      result: SessionsListResult | null,
      previous: ReturnType<typeof host.readState>,
      primary: SessionsListResult | null,
      agentId?: string | null,
    ) {
      const presented = reconcileRosterPresentationMetadata(
        result,
        previous.resultCached ? null : previous.result,
      );
      observations.inherit(presented, result, agentId);
      const previousRows = previous.result?.sessions ?? [];
      let accepted = merge(
        presented,
        previous.resultCached ? previousRows.filter(provenance.hasObservation) : previousRows,
        agentId,
        previous.agentId,
      );
      accepted = merge(accepted, primary?.sessions ?? [], agentId, host.readState().agentId);
      return projectSessionResultRows(accepted, observations.projectRows(accepted?.sessions ?? []));
    },
    inherit(
      result: SessionsListResult | null,
      previous: SessionsListResult | null,
      agentId?: string | null,
    ) {
      const previousRows = indexRows(previous?.sessions ?? [], agentId);
      for (const row of result?.sessions ?? []) {
        inheritRow(row, previousRows.get(identity(row, agentId) ?? ""));
      }
    },
  };
  return observations;
}
