import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type {
  SessionConnectionOwner,
  SessionConnectionScope,
  SessionRowTarget,
} from "./session-capability.ts";
import {
  areUiSessionKeysEquivalent,
  normalizeAgentId,
  parseAgentSessionKey,
} from "./session-key.ts";
import type { ObservedSessionList } from "./session-list-query.ts";
import { createSessionRowProvenance } from "./session-row-provenance.ts";
import {
  createSessionRunTerminalReconciler,
  type SessionRunTerminal,
} from "./session-run-terminal.ts";

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
    sessionId: string | null;
    invalidatedRevision: number;
    retired: boolean;
  };
  listener: (row: GatewaySessionRow | null) => void;
  isValid: (sessionId: string) => boolean;
  decorate: (row: GatewaySessionRow) => GatewaySessionRow | null;
};

type RowProjection = (entry: ObservedSessionRow) => {
  row: GatewaySessionRow | null;
  invalidateRevision?: number;
  readRevision?: number;
};

type SessionRowAdmission = { row: GatewaySessionRow; revision: number };

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
  const { owner, identity, inheritRow, mergeRow, observeReadRow, rowRevision } = provenance;
  const registeredRows = new Set<RegisteredSessionRow>();
  const registrationIsAttached = (entry: RegisteredSessionRow) =>
    registeredRows.has(entry) && entry.scope !== null && host.connection.isCurrent(entry.scope);
  const registrationIsCurrent = (entry: RegisteredSessionRow) =>
    registrationIsAttached(entry) &&
    !entry.snapshot.retired &&
    (entry.snapshot.sessionId === null || entry.isValid(entry.snapshot.sessionId));
  const matchesTarget = (row: GatewaySessionRow, target: SessionRowTarget) => {
    const parsedAgent = parseAgentSessionKey(row.key)?.agentId;
    return (
      identity(row, target.agentId) !== null &&
      areUiSessionKeysEquivalent(row.key, target.key) &&
      owner(row, target.agentId) === normalizeAgentId(target.agentId) &&
      (!parsedAgent ||
        !row.agentId ||
        normalizeAgentId(row.agentId) === normalizeAgentId(parsedAgent))
    );
  };
  const registeredRow = (entry: RegisteredSessionRow) =>
    registrationIsCurrent(entry) ? entry.snapshot.row : null;
  const acceptsRow = (
    entry: RegisteredSessionRow,
    row: GatewaySessionRow,
    revision: number,
    seedHeld = false,
  ) =>
    registrationIsCurrent(entry) &&
    matchesTarget(row, entry.target) &&
    Boolean(row.sessionId && entry.isValid(row.sessionId)) &&
    (revision > entry.snapshot.invalidatedRevision ||
      (seedHeld &&
        entry.snapshot.sessionId === null &&
        entry.snapshot.invalidatedRevision === 0 &&
        provenance.hasObservation(row))) &&
    (entry.snapshot.sessionId === null || entry.snapshot.sessionId === row.sessionId);
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
  ) => {
    if (!result || rows.length === 0) {
      return result;
    }
    const offered = indexRows(rows, sourceAgentId);
    let changed = false;
    const sessions = result.sessions.map((current) => {
      const key = identity(current, agentId);
      const row = key ? offered.get(key) : undefined;
      const next = row ? mergeRow(current, row, agentId) : current;
      changed ||= next !== current;
      return next;
    });
    return changed ? { ...result, sessions } : result;
  };
  const captureHeldRows = () => {
    const state = host.readState();
    const primaryRows = indexRows(state.result?.sessions ?? [], state.agentId);
    const epoch = host.connection.capture()?.epoch;
    const managedRows = [...lists.values()]
      .filter((entry) => entry.connectionEpoch === epoch)
      .map((entry) => indexRows(entry.snapshot.result?.sessions ?? [], entry.snapshot.agentId));
    const descriptors = [...registeredRows].flatMap((entry) => {
      const row = registeredRow(entry);
      return row ? [indexRows([row], entry.target.agentId)] : [];
    });
    return { state, primaryRows, observedRows: [...managedRows, ...descriptors] };
  };
  const createFieldProjection = () => {
    const { state, primaryRows, observedRows } = captureHeldRows();
    return (row: GatewaySessionRow, agentId?: string | null) => {
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
      for (const rows of observedRows) {
        const offered = rows.get(key);
        if (offered) {
          current = mergeRow(current, offered, agentId);
        }
      }
      return current;
    };
  };
  const projectFields = (row: GatewaySessionRow, agentId?: string | null) =>
    createFieldProjection()(row, agentId);
  const heldRowsFor = (row: GatewaySessionRow, agentId?: string | null) => {
    const key = identity(row, agentId);
    if (!key) {
      return [];
    }
    const { primaryRows, observedRows } = captureHeldRows();
    return [primaryRows, ...observedRows].flatMap((rows) => {
      const current = rows.get(key);
      return current ? [current] : [];
    });
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
  ): { changed: boolean; notify: (publishedRows?: readonly SessionRowAdmission[]) => void } => {
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
      const projected = project(entry);
      const decorated = host.decorate(projected, entry);
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
        acceptsRow(
          entry,
          projected.row,
          projected.readRevision ?? rowRevision(projected.row),
          admitRead,
        )
          ? projected.row
          : null;
      const decorated = row ? entry.decorate(row) : null;
      const visible =
        row &&
        decorated &&
        matchesTarget(decorated, entry.target) &&
        identity(decorated, entry.target.agentId) === identity(row, entry.target.agentId)
          ? inheritRow(decorated, row)
          : null;
      const invalidatedRevision = !previous.row
        ? Math.max(previous.invalidatedRevision, projected.invalidateRevision ?? 0)
        : previous.invalidatedRevision;
      if (
        row !== previous.row ||
        visible !== previous.visible ||
        invalidatedRevision !== previous.invalidatedRevision
      ) {
        rowChanges.push({
          entry,
          previous,
          snapshot: {
            // Settled local row intents remain held, as they do in existing lists.
            row: visible ?? row,
            visible,
            invalidatedRevision,
            sessionId: previous.sessionId ?? row?.sessionId ?? null,
            retired: false,
          },
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
    const notify = (publishedRows: readonly SessionRowAdmission[] = []) => {
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
      for (const { entry, snapshot } of rowChanges) {
        if (!host.connection.isCurrent(scope)) {
          return;
        }
        if (
          registrationIsAttached(entry) &&
          (snapshot.retired || registrationIsCurrent(entry)) &&
          entry.snapshot === snapshot
        ) {
          entry.listener(snapshot.visible);
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
    const project = createFieldProjection();
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
          ...(!entry.row && matching ? { readRevision: readRevisions.get(matching) ?? 0 } : {}),
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
      listener: (row: GatewaySessionRow | null) => void,
      options: Pick<RegisteredSessionRow, "isValid" | "decorate">,
    ) {
      const entry: RegisteredSessionRow = {
        target: Object.freeze({ ...target }),
        scope: host.connection.capture(),
        listener,
        ...options,
        snapshot: {
          row: null,
          visible: null,
          sessionId: null,
          invalidatedRevision: 0,
          retired: false,
        },
      };
      registeredRows.add(entry);
      return {
        current: () => (registeredRow(entry) ? entry.snapshot.visible : null),
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
    currentRow,
    mergeRows: merge,
    publishedRow(matches: (row: GatewaySessionRow, agentId?: string | null) => boolean) {
      for (const entry of registeredRows) {
        const row = registeredRow(entry);
        if (row && matches(row, entry.target.agentId)) {
          return row;
        }
      }
      return undefined;
    },
    projectFields,
    projectRows: (rows: readonly GatewaySessionRow[]): GatewaySessionRow[] => {
      if (rows.length === 0) {
        return [];
      }
      const project = createFieldProjection();
      return rows.map((row) => {
        const projected = project(row);
        // Field freshness cannot change the caller's tree keys or membership.
        return projected.key === row.key
          ? projected
          : inheritRow({ ...projected, key: row.key }, projected);
      });
    },
    stageObservedRows,
    stageManagedResults,
    rowRevision,
    hasLiveObservation: (row: GatewaySessionRow) =>
      host.connection.capture() !== null && provenance.hasObservation(row),
    isCurrentRow: (
      row: GatewaySessionRow,
      revision = rowRevision(row),
      agentId?: string | null,
    ): boolean => !heldRowsFor(row, agentId).some((current) => rowRevision(current) > revision),
    bindOwner: (result: SessionsListResult | null, agentId?: string | null) => {
      for (const row of result?.sessions ?? []) {
        provenance.bindOwner(row, agentId);
      }
    },
    observeReadRow,
    observeEvent: provenance.observeEvent,
    stageRunTerminal(
      this: void,
      terminal: SessionRunTerminal,
      event: { scope: SessionConnectionScope | null; revision: number },
    ) {
      const project = createFieldProjection();
      const reconcileRow = (agentId: string | null) =>
        createSessionRunTerminalReconciler(terminal, {
          agentId: (row) => owner(row, agentId),
          project: (row) => project(row, agentId),
          observe: (row, source, fields) => {
            inheritRow(row, source);
            // Terminal time is local; only Gateway rows supply the updatedAt clock.
            observations.observeEvent(row, fields, event.revision, null, agentId);
          },
        });
      const reconcile = (result: SessionsListResult | null, agentId: string | null) => {
        if (!result) {
          return result;
        }
        const sessions = result.sessions.map(reconcileRow(agentId));
        return sessions.some((row, index) => row !== result.sessions[index])
          ? { ...result, sessions }
          : result;
      };
      const state = host.readState();
      const result = reconcile(state.result, state.agentId);
      // Compute every owner against the unchanged held rows: consuming an overlap
      // in one window must not make another reject the same completed run.
      const staged = stageManagedResults(
        event.scope,
        (entry) => reconcile(entry.snapshot.result, entry.snapshot.agentId),
        (entry) => {
          const matches = terminal.sessionKeys.some((key) => {
            const agentId = parseAgentSessionKey(key)?.agentId ?? terminal.agentId;
            return Boolean(
              agentId &&
              areUiSessionKeysEquivalent(key, entry.target.key) &&
              normalizeAgentId(agentId) === normalizeAgentId(entry.target.agentId),
            );
          });
          return {
            row: entry.row && matches ? reconcileRow(entry.target.agentId)(entry.row) : entry.row,
            ...(!entry.row && matches ? { invalidateRevision: event.revision } : {}),
          };
        },
      );
      return { result, changed: result !== state.result || staged.changed, notify: staged.notify };
    },
    // Local copies keep source provenance; they are not new Gateway reads.
    copyRow: (row: GatewaySessionRow, patch: Partial<GatewaySessionRow>) =>
      inheritRow({ ...row, ...patch }, row),
    captureReconciliation(revision: number) {
      const scope = host.connection.capture();
      return {
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
          accepted = merge(accepted, [row], agentId, entry.target.agentId);
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
