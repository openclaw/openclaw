import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { projectSessionResultRows } from "./reconcile.ts";
import type {
  SessionConnectionOwner,
  SessionConnectionScope,
  SessionRowTarget,
  SessionRowEventListener,
  SessionRowListener,
} from "./session-capability.ts";
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
import { createSessionRowProvenance } from "./session-row-provenance.ts";
import { isOlderSessionSnapshot, type SessionChangedRowResult } from "./session-row-reconcile.ts";
import { createSessionRunTerminalStaging } from "./session-run-terminal.ts";

type ObservedSessionRow = {
  target: SessionRowTarget;
  row: GatewaySessionRow | null;
};

type RegisteredSessionRow = {
  target: SessionRowTarget;
  scope: SessionConnectionScope | null;
  snapshot: {
    row: GatewaySessionRow | null;
    visible: GatewaySessionRow | null;
    hasObserved: boolean;
    sessionId: string | null;
    invalidatedRevision: number;
    retired: boolean;
  };
  listener: SessionRowListener;
  onInvalidate?: (reason?: string) => void;
  onEvent?: SessionRowEventListener;
  isValid: (sessionId: string) => boolean;
  decorate: (row: GatewaySessionRow) => GatewaySessionRow | null;
};

type RowProjection = (entry: ObservedSessionRow) => {
  row: GatewaySessionRow | null;
  invalidateRevision?: number;
  observationRevision?: number;
  eventResult?: SessionChangedRowResult;
};

type SessionRowAdmission = { row: GatewaySessionRow; revision: number };
type RowEventDelivery = SessionEventDelivery<RegisteredSessionRow>;

/** Metadata follows held rows; wire values stay in their existing roster owners. */
export function createSessionRosterObservations(
  host: {
    connection: SessionConnectionOwner;
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
  const { owner, identity, inheritRow, mergeRow, rowRevision } = provenance;
  const registeredRows = new Set<RegisteredSessionRow>();
  const registrationIsAttached = (entry: RegisteredSessionRow) =>
    registeredRows.has(entry) && entry.scope !== null && host.connection.isCurrent(entry.scope);
  const registrationIsCurrent = (entry: RegisteredSessionRow) =>
    registrationIsAttached(entry) &&
    !entry.snapshot.retired &&
    (entry.snapshot.sessionId === null || entry.isValid(entry.snapshot.sessionId));
  const captureEventDelivery = createSessionEventDelivery(
    registeredRows,
    host.connection,
    registrationIsAttached,
    registrationIsCurrent,
    provenance.hasNewerFacts,
  );
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
  const registeredRow = (entry: RegisteredSessionRow) =>
    registrationIsCurrent(entry) ? entry.snapshot.row : null;
  const acceptsRowIdentity = (entry: RegisteredSessionRow, row: GatewaySessionRow) =>
    registrationIsCurrent(entry) &&
    matchesTarget(row, entry.target) &&
    Boolean(row.sessionId && entry.isValid(row.sessionId)) &&
    (entry.snapshot.sessionId === null || entry.snapshot.sessionId === row.sessionId);
  const acceptsRow = (
    entry: RegisteredSessionRow,
    row: GatewaySessionRow,
    revision: number,
    seedHeld = false,
  ) =>
    acceptsRowIdentity(entry, row) &&
    (revision > entry.snapshot.invalidatedRevision ||
      (seedHeld &&
        entry.snapshot.sessionId === null &&
        entry.snapshot.invalidatedRevision === 0 &&
        provenance.hasObservation(row)));
  const successorRetirement = (
    entry: RegisteredSessionRow,
    admissions: readonly SessionRowAdmission[],
  ) => {
    const previous = entry.snapshot;
    const sessionId = previous.sessionId;
    if (!registrationIsAttached(entry) || previous.retired || !sessionId) {
      return undefined;
    }
    const successor = admissions.some(
      ({ row, revision }) =>
        row.sessionId &&
        row.sessionId !== sessionId &&
        matchesTarget(row, entry.target) &&
        entry.isValid(row.sessionId) &&
        (!entry.isValid(sessionId) ||
          (revision > previous.invalidatedRevision &&
            (!previous.row || !provenance.hasNewerFacts(previous.row, revision)))),
    );
    return successor
      ? { entry, previous, snapshot: { ...previous, row: null, visible: null, retired: true } }
      : undefined;
  };
  const indexRows = (rows: readonly GatewaySessionRow[], agentId?: string | null) => {
    const indexed = new Map<string, GatewaySessionRow>();
    for (const row of rows) {
      const key = identity(row, agentId);
      if (key) {
        indexed.set(key, row);
      }
    }
    return indexed;
  };
  const merge = (
    result: SessionsListResult | null,
    rows: readonly GatewaySessionRow[],
    agentId?: string | null,
    sourceAgentId?: string | null,
    incomingRows?: ReadonlyMap<string, GatewaySessionRow>,
  ) => {
    if (!result || rows.length === 0) {
      return result;
    }
    const offered = indexRows(rows, sourceAgentId);
    const sessions = result.sessions.map((current) => {
      const key = identity(current, agentId);
      const row = key && offered.get(key);
      if (!row) {
        return current;
      }
      const incoming = key && incomingRows?.get(key);
      // A held descriptor rejects older full rows before they can donate
      // previously unseen presentation fields. List-to-list merges retain
      // their independent field observations.
      const rejectedRead =
        incoming &&
        (rowRevision(row) > rowRevision(incoming) || isOlderSessionSnapshot(incoming, row));
      const held = rejectedRead && projectFields(row, sourceAgentId);
      return held
        ? held.key === current.key
          ? held
          : inheritRow({ ...held, key: current.key }, held)
        : mergeRow(current, row, agentId);
    });
    return projectSessionResultRows(result, sessions);
  };
  const captureHeldRows = () => {
    const state = host.readState();
    const primaryRows = indexRows(state.result?.sessions ?? [], state.agentId);
    const epoch = host.connection.capture()?.epoch;
    const observedRows = new Map<string, GatewaySessionRow[]>();
    const append = (key: string, row: GatewaySessionRow) => {
      const rows = observedRows.get(key);
      if (rows) {
        rows.push(row);
      } else {
        observedRows.set(key, [row]);
      }
    };
    for (const entry of lists.values()) {
      if (entry.connectionEpoch === epoch) {
        for (const [key, row] of indexRows(
          entry.snapshot.result?.sessions ?? [],
          entry.snapshot.agentId,
        )) {
          append(key, row);
        }
      }
    }
    for (const entry of registeredRows) {
      const row = registeredRow(entry);
      const key = row && identity(row, entry.target.agentId);
      if (row && key) {
        append(key, row);
      }
    }
    return { state, primaryRows, observedRows };
  };
  const prepareProjection = () => {
    const { state, primaryRows, observedRows } = captureHeldRows();
    const projectFields = (row: GatewaySessionRow, agentId?: string | null) => {
      const key = identity(row, agentId);
      if (!key) {
        return row;
      }
      let current = row;
      const primary = primaryRows.get(key);
      if (primary) {
        // Identical live reads reuse the primary row; cache-only fields lose ties to live input.
        current =
          state.resultCached && rowRevision(primary) === 0
            ? mergeRow(current, primary, agentId)
            : mergeRow(primary, current, agentId);
      }
      for (const offered of observedRows.get(key) ?? []) {
        current = mergeRow(current, offered, agentId);
      }
      // Field freshness cannot change the caller's tree key.
      return current.key === row.key ? current : inheritRow({ ...current, key: row.key }, current);
    };
    return {
      projectFields,
      projectRows: (rows: readonly GatewaySessionRow[]): GatewaySessionRow[] =>
        rows.map((row) => projectFields(row)),
    };
  };
  const projectFields = (row: GatewaySessionRow, agentId?: string | null) =>
    prepareProjection().projectFields(row, agentId);
  const heldRowsFor = (
    row: GatewaySessionRow,
    agentId?: string | null,
    held?: ReturnType<typeof captureHeldRows>,
  ) => {
    const key = identity(row, agentId);
    if (!key) {
      return [];
    }
    const { primaryRows, observedRows } = held ?? captureHeldRows();
    const primary = primaryRows.get(key);
    return [...(primary ? [primary] : []), ...(observedRows.get(key) ?? [])];
  };
  const observeReadRow = (row: GatewaySessionRow, revision: number, agentId?: string | null) =>
    provenance.observeReadRow(row, revision, agentId, heldRowsFor(row, agentId));
  const observeReadRows = (
    rows: readonly GatewaySessionRow[],
    revision: number,
    agentId?: string | null,
  ) => {
    if (rows.length === 0) {
      return [];
    }
    const held = captureHeldRows();
    return rows.map((row) => ({
      row,
      select: provenance.observeReadRow(row, revision, agentId, heldRowsFor(row, agentId, held)),
    }));
  };
  const currentRow = (row: GatewaySessionRow, agentId?: string | null) => {
    const held = heldRowsFor(row, agentId)[0];
    return held ? projectFields(held, agentId) : undefined;
  };
  const stageManagedResults = (
    scope: SessionConnectionScope | null,
    project: (entry: ObservedSessionList) => SessionsListResult | null,
    projectRow?: RowProjection,
    admitRead = false,
    admittedRows: readonly SessionRowAdmission[] = [],
    event?: RowEventDelivery,
  ): {
    changed: boolean;
    notify: (publishedRows?: readonly SessionRowAdmission[], reason?: string) => void;
  } => {
    if (!scope || !host.connection.isCurrent(scope)) {
      return { changed: false, notify: () => {} };
    }
    const registrations = [...registeredRows];
    const changes: Array<{
      key: string;
      entry: ObservedSessionList;
      previous: ObservedSessionList["snapshot"];
      snapshot: ObservedSessionList["snapshot"];
    }> = [];
    const rowChanges: Array<{
      entry: RegisteredSessionRow;
      previous: RegisteredSessionRow["snapshot"];
      snapshot: RegisteredSessionRow["snapshot"];
    }> = [];
    for (const [key, entry] of lists) {
      if (entry.connectionEpoch !== scope.epoch) {
        continue;
      }
      const previous = entry.snapshot;
      const decorated = host.decorate(project(entry), entry);
      if (decorated !== entry.snapshot.result) {
        changes.push({ key, entry, previous, snapshot: { ...previous, result: decorated } });
      }
    }
    for (const entry of registrations) {
      const retirement = successorRetirement(entry, admittedRows);
      if (retirement) {
        rowChanges.push(retirement);
        continue;
      }
      if (!registrationIsCurrent(entry)) {
        continue;
      }
      const previous = entry.snapshot;
      const held = registeredRow(entry);
      const projected = projectRow?.({ target: entry.target, row: held }) ?? { row: held };
      const row =
        projected.row &&
        (held !== null || admitRead) &&
        // Invalidation fences incoming reads, not accepted updates to the held incarnation.
        (projected.row === held ||
          (admitRead
            ? acceptsRow(
                entry,
                projected.row,
                projected.observationRevision ?? rowRevision(projected.row),
                true,
              )
            : acceptsRowIdentity(entry, projected.row)))
          ? projected.row
          : admitRead && projected.row
            ? held // Rejecting a stale read must not remove the current descriptor.
            : null;
      const decorated = row ? entry.decorate(row) : null;
      const visible =
        row &&
        decorated &&
        matchesTarget(decorated, entry.target) &&
        identity(decorated, entry.target.agentId) === identity(row, entry.target.agentId)
          ? inheritRow(decorated, row)
          : null;
      const invalidatedRevision =
        !previous.row || entry.onInvalidate
          ? Math.max(previous.invalidatedRevision, projected.invalidateRevision ?? 0)
          : previous.invalidatedRevision;
      const hasObserved =
        previous.hasObserved || row !== null || Boolean(projected.eventResult?.deletedKey);
      let nextSnapshot = previous;
      if (
        row !== previous.row ||
        visible !== previous.visible ||
        hasObserved !== previous.hasObserved ||
        invalidatedRevision !== previous.invalidatedRevision
      ) {
        nextSnapshot = {
          // Settled local row intents remain held, as they do in existing lists.
          row: visible ?? row,
          visible,
          hasObserved,
          invalidatedRevision,
          sessionId: previous.sessionId ?? row?.sessionId ?? null,
          retired: Boolean(projected.eventResult?.deletedKey),
        };
        rowChanges.push({
          entry,
          previous,
          snapshot: nextSnapshot,
        });
      }
      if (
        entry.onEvent &&
        projected.eventResult &&
        (!projected.eventResult.admittedRow ||
          acceptsRowIdentity(entry, projected.eventResult.admittedRow))
      ) {
        event?.results.set(entry, {
          snapshot: nextSnapshot,
          result: { ...projected.eventResult, row: visible ?? undefined },
        });
      }
    }
    if (!host.connection.isCurrent(scope)) {
      return { changed: false, notify: () => {} };
    }
    // Every held window receives the fact before a listener can start another read.
    let changed = false;
    for (const change of changes) {
      if (lists.get(change.key) === change.entry && change.entry.snapshot === change.previous) {
        change.entry.snapshot = change.snapshot;
        changed = true;
      }
    }
    for (const change of rowChanges) {
      if (
        registrationIsAttached(change.entry) &&
        (change.snapshot.retired || registrationIsCurrent(change.entry)) &&
        change.entry.snapshot === change.previous
      ) {
        change.entry.snapshot = change.snapshot;
        changed = true;
      }
    }
    const notify = (publishedRows: readonly SessionRowAdmission[] = [], reason?: string) => {
      if (!host.connection.isCurrent(scope)) {
        return;
      }
      // A publication can retire its original leases, never a reentrant replacement.
      for (const entry of registrations) {
        const retirement = successorRetirement(entry, publishedRows);
        if (retirement) {
          entry.snapshot = retirement.snapshot;
          rowChanges.push(retirement);
        }
      }
      for (const { key, entry, snapshot } of changes) {
        for (const listener of entry.listeners) {
          if (!host.connection.isCurrent(scope)) {
            return;
          }
          if (lists.get(key) !== entry || entry.snapshot !== snapshot) {
            break;
          }
          listener(snapshot);
        }
      }
      for (const { entry, previous, snapshot } of rowChanges) {
        if (!host.connection.isCurrent(scope)) {
          return;
        }
        if (
          registrationIsAttached(entry) &&
          (snapshot.retired || registrationIsCurrent(entry)) &&
          entry.snapshot === snapshot
        ) {
          // A captured recipient must finish this frame before replacing its binding.
          if (snapshot.retired && entry.onEvent && event?.captures(entry)) {
            entry.listener(snapshot.visible, { eventPending: true });
          } else {
            entry.listener(snapshot.visible);
          }
          if (
            registrationIsCurrent(entry) &&
            entry.snapshot === snapshot &&
            snapshot.invalidatedRevision > previous.invalidatedRevision
          ) {
            entry.onInvalidate?.(reason);
          }
        }
      }
    };
    return { changed, notify };
  };
  const stageObservedRows = (
    rows: readonly GatewaySessionRow[],
    scope: SessionConnectionScope | null,
    agentId?: string | null,
    issuedRevision?: number,
    managed = true,
  ) => {
    const offered = indexRows(rows, agentId);
    const readRevisions = new WeakMap(
      rows.map((row) => [row, issuedRevision ?? rowRevision(row)] as const),
    );
    const { projectFields: project } = prepareProjection();
    return stageManagedResults(
      scope,
      (entry) => merge(entry.snapshot.result, managed ? rows : [], entry.snapshot.agentId, agentId),
      (entry) => {
        const key = entry.row ? identity(entry.row, entry.target.agentId) : null;
        const matching = key
          ? offered.get(key)
          : [...offered.values()].find(
              (row) =>
                owner(row, agentId) === normalizeAgentId(entry.target.agentId) &&
                matchesTarget(row, entry.target),
            );
        return {
          row: matching
            ? entry.row
              ? mergeRow(entry.row, project(matching, agentId), entry.target.agentId)
              : project(matching, agentId)
            : entry.row,
          ...(!entry.row && matching
            ? { observationRevision: readRevisions.get(matching) ?? 0 }
            : {}),
        };
      },
      true,
      rows.map((row) => ({ row, revision: issuedRevision ?? rowRevision(row) })),
    ).notify;
  };
  const observations = {
    reset() {
      // Retained cache rows carry presentation, not evidence from the retired connection.
      provenance.reset();
      registeredRows.clear();
    },
    registerRow(
      this: void,
      target: SessionRowTarget,
      listener: SessionRowListener,
      options: Pick<RegisteredSessionRow, "isValid" | "decorate" | "onInvalidate" | "onEvent">,
    ) {
      const entry: RegisteredSessionRow = {
        target: Object.freeze({ ...target }),
        scope: host.connection.capture(),
        listener,
        ...options,
        snapshot: {
          row: null,
          visible: null,
          hasObserved: false,
          sessionId: null,
          invalidatedRevision: 0,
          retired: false,
        },
      };
      registeredRows.add(entry);
      return {
        current: () => (registeredRow(entry) ? entry.snapshot.visible : null),
        sessionId: () => entry.snapshot.sessionId,
        hasObserved: () => entry.snapshot.hasObserved,
        isCurrent: () => registrationIsCurrent(entry),
        readInvalidated: (revision: number) => revision <= entry.snapshot.invalidatedRevision,
        acceptsRead: (row: GatewaySessionRow, revision: number) => acceptsRow(entry, row, revision),
        clear: (revision: number) => {
          const held = registeredRow(entry);
          if (!registrationIsCurrent(entry) || (held && provenance.hasNewerFacts(held, revision))) {
            return () => {};
          }
          const snapshot = {
            ...entry.snapshot,
            row: null,
            visible: null,
            hasObserved: true,
            invalidatedRevision: Math.max(entry.snapshot.invalidatedRevision, revision),
          };
          entry.snapshot = snapshot;
          return () => {
            if (registrationIsCurrent(entry) && entry.snapshot === snapshot) {
              entry.listener(null);
            }
          };
        },
        dispose: () => {
          registeredRows.delete(entry);
        },
      };
    },
    inheritRow,
    mergeRow,
    currentRow,
    mergeRows: merge,
    publishedRow(
      this: void,
      matches: (row: GatewaySessionRow, agentId?: string | null) => boolean,
    ) {
      const state = host.readState();
      // Primary rows own shared presentation before managed and descriptor-only rows.
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
        const row = registeredRow(entry);
        if (row && matches(row, entry.target.agentId)) {
          return row;
        }
      }
      return undefined;
    },
    projectFields,
    prepareProjection,
    projectRows: (rows: readonly GatewaySessionRow[]): GatewaySessionRow[] =>
      rows.length === 0 ? [] : prepareProjection().projectRows(rows),
    stageObservedRows,
    stageManagedResults,
    captureEventDelivery,
    rowRevision,
    hasLiveObservation: (row: GatewaySessionRow) =>
      host.connection.capture() !== null && provenance.hasObservation(row),
    isCurrentRow: (row: GatewaySessionRow, revision?: number, agentId?: string | null): boolean => {
      const held = heldRowsFor(row, agentId);
      const readRevision = revision ?? rowRevision(row);
      // Cold descriptors carry first-read fences before any live row can carry their receipts.
      return (
        !held.some((current) => rowRevision(current) > readRevision) &&
        (revision === undefined ||
          held.some(provenance.hasObservation) ||
          ![...registeredRows].some(
            (entry) =>
              acceptsRowIdentity(entry, row) && !acceptsRow(entry, row, readRevision, true),
          ))
      );
    },
    bindOwner: (result: SessionsListResult | null, agentId?: string | null) => {
      for (const row of result?.sessions ?? []) {
        provenance.bindOwner(row, agentId);
      }
    },
    observeReadRows,
    observeFields: provenance.observeFields,
    fieldNames: provenance.fieldNames,
    fieldObservation: provenance.fieldObservation,
    stageRunTerminal: createSessionRunTerminalStaging({
      readState: host.readState,
      prepareProjection,
      provenance,
      stage: stageManagedResults,
    }),
    // Local copies keep source provenance; they are not new Gateway reads.
    copyRow: (row: GatewaySessionRow, patch: Partial<GatewaySessionRow>) =>
      inheritRow({ ...row, ...patch }, row),
    captureReconciliation(revision: number) {
      const scope = host.connection.capture();
      return {
        scope,
        revision,
        observe: (row: GatewaySessionRow, agentId?: string | null) =>
          observeReadRow(row, revision, agentId),
        isCurrent: (row: GatewaySessionRow | undefined, agentId?: string | null) =>
          scope !== null &&
          host.connection.isCurrent(scope) &&
          (!row || observations.isCurrentRow(row, Math.max(revision, rowRevision(row)), agentId)),
        stage: (row: GatewaySessionRow, agentId?: string | null) =>
          stageObservedRows([row], scope, agentId, revision),
      };
    },
    accept(
      result: SessionsListResult | null,
      previous: SessionsListResult | null,
      primary: SessionsListResult | null,
      agentId?: string | null,
      previousAgentId = agentId,
      primaryAgentId = host.readState().agentId,
    ) {
      const incomingRows = indexRows(result?.sessions ?? [], agentId);
      let accepted = merge(
        merge(result, previous?.sessions ?? [], agentId, previousAgentId),
        primary?.sessions ?? [],
        agentId,
        primaryAgentId,
      );
      const epoch = host.connection.capture()?.epoch;
      for (const entry of lists.values()) {
        if (entry.connectionEpoch === epoch) {
          accepted = merge(
            accepted,
            entry.snapshot.result?.sessions ?? [],
            agentId,
            entry.snapshot.agentId,
          );
        }
      }
      for (const entry of registeredRows) {
        const row = registeredRow(entry);
        if (row) {
          accepted = merge(accepted, [row], agentId, entry.target.agentId, incomingRows);
        }
      }
      return accepted;
    },
    inherit(
      this: void,
      result: SessionsListResult | null,
      previous: SessionsListResult | null,
      donor?: SessionsListResult | null,
      agentId?: string | null,
    ): void {
      const previousRows = indexRows(previous?.sessions ?? [], agentId);
      const donors = indexRows(donor?.sessions ?? [], agentId);
      for (const row of result?.sessions ?? []) {
        const key = identity(row, agentId);
        if (key) {
          inheritRow(row, previousRows.get(key), donors.get(key));
        }
      }
    },
  };
  return observations;
}
