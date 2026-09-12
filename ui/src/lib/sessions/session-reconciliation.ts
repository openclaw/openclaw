import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import {
  readSessionChangedEvent,
  reconcileSessionChanged,
  reconcileSessionChangedRow,
  reconcileSessionHistory,
  reconcileSessionRow,
  type SessionChangedResult,
  type SessionReconcileOptions,
} from "./reconcile.ts";
import type {
  SessionCapability,
  SessionConnectionOwner,
  SessionGateway,
  SessionRowTarget,
  SessionState,
} from "./session-capability.ts";
import type { createSessionDeletions } from "./session-deletions.ts";
import type { createSessionGitHubPublication } from "./session-github-publication.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  uiSessionEventMatches,
} from "./session-key.ts";
import type { createSessionMutations } from "./session-mutations.ts";
import type { SessionPatchRowFact } from "./session-pending-rows.ts";
import type { createSessionPermissionProjection } from "./session-permission-projection.ts";
import type { createSessionRosterRefresh } from "./session-roster-refresh.ts";
import type { createSessionThinkingClaims } from "./session-thinking-claims.ts";

type Host = {
  readState: () => SessionState;
  publish: (state: SessionState) => void;
  canonicalListRevision: () => number;
  connection: SessionConnectionOwner;
  snapshot: () => SessionGateway["snapshot"];
  permissions: Pick<
    ReturnType<typeof createSessionPermissionProjection>,
    "observeEventRow" | "applyRow"
  >;
  mutations: Pick<
    ReturnType<typeof createSessionMutations>,
    "observeArchiveState" | "applyPendingRow" | "observePendingFields"
  >;
  thinkingClaims: Pick<ReturnType<typeof createSessionThinkingClaims>, "observeEvent">;
  decorate: (result: SessionsListResult | null) => SessionsListResult | null;
  deletions: Pick<
    ReturnType<typeof createSessionDeletions>,
    "acceptsGeneration" | "deletionState" | "observe"
  >;
  githubPublication: Pick<
    ReturnType<typeof createSessionGitHubPublication>,
    "observeRows" | "observeEvent"
  >;
  roster: Pick<
    ReturnType<typeof createSessionRosterRefresh>,
    | "captureReconciliation"
    | "captureEvent"
    | "currentRow"
    | "publishedRow"
    | "mergeRows"
    | "stageObservedRows"
    | "registerRow"
    | "inherit"
    | "observeEvent"
    | "stageManagedResults"
    | "projectRows"
    | "invalidateManagedLists"
    | "inheritRow"
    | "isCurrentRow"
    | "rowRevision"
    | "hasLiveObservation"
    | "projectFields"
  >;
};

export function createSessionReconciliation(host: Host) {
  const pendingFields = ["pinned", "pinnedAt", "unread"] as const;
  const projectRowFields = (row: GatewaySessionRow, agentId?: string | null) => {
    const projected = host.roster.projectFields(row, agentId);
    return projected.key === row.key
      ? projected
      : host.roster.inheritRow({ ...projected, key: row.key }, projected);
  };
  const capturePatchFields = (target: SessionRowTarget & { sessionId: string }) => {
    const captured = host.roster.captureReconciliation();
    const scope = host.connection.capture();
    const owned = { ...target, key: target.key.trim(), agentId: normalizeAgentId(target.agentId) };
    const validTarget = Boolean(owned.key && target.agentId.trim() && owned.sessionId.trim());
    return (fact: SessionPatchRowFact): void => {
      const current = () =>
        Boolean(scope && host.connection.isCurrent(scope)) &&
        captured.isCurrent(undefined, owned.agentId) &&
        host.deletions.acceptsGeneration(owned.key, owned.sessionId, owned.agentId) &&
        !host.deletions.deletionState(owned.key, owned.agentId, owned.sessionId);
      if (
        !validTarget ||
        !fact.agentId.trim() ||
        !areUiSessionKeysEquivalent(fact.key, owned.key) ||
        normalizeAgentId(fact.agentId) !== owned.agentId ||
        fact.sessionId !== owned.sessionId ||
        !current()
      ) {
        return;
      }
      const fields = Object.keys(fact.fields);
      const reconcileRow = (row: GatewaySessionRow, ownerAgentId?: string | null) => {
        const parsedAgentId = parseAgentSessionKey(row.key)?.agentId;
        const sourceAgentId = parsedAgentId ?? row.agentId ?? ownerAgentId;
        if (
          !sourceAgentId ||
          normalizeAgentId(sourceAgentId) !== owned.agentId ||
          (parsedAgentId &&
            row.agentId &&
            normalizeAgentId(row.agentId) !== normalizeAgentId(parsedAgentId)) ||
          !areUiSessionKeysEquivalent(row.key, owned.key) ||
          row.sessionId !== owned.sessionId
        ) {
          return row;
        }
        const source = { ...row, ...fact.fields };
        for (const [name, value] of Object.entries(fact.fields)) {
          if (value === undefined) {
            Reflect.deleteProperty(source, name);
          }
        }
        host.roster.inheritRow(source, row);
        const select = host.roster.observeEvent(
          source,
          fields,
          captured.revision,
          fact.updatedAt,
          owned.agentId,
        );
        const projected = projectRowFields(source, owned.agentId);
        host.mutations.observePendingFields(
          source,
          select(projected, pendingFields),
          owned.agentId,
        );
        return projected;
      };
      const reconcileResult = (result: SessionsListResult | null, agentId?: string | null) => {
        if (!result) {
          return result;
        }
        const sessions = result.sessions.map((row) => reconcileRow(row, agentId));
        return sessions.some((row, index) => row !== result.sessions[index])
          ? { ...result, sessions }
          : result;
      };
      const state = host.readState();
      const result = reconcileResult(state.result, state.agentId);
      const staged = host.roster.stageManagedResults(
        scope,
        (entry) => reconcileResult(entry.snapshot.result, entry.snapshot.agentId),
        (entry) => ({ row: entry.row ? reconcileRow(entry.row, entry.target.agentId) : null }),
      );
      if (!current()) {
        return;
      }
      if (result !== state.result) {
        host.publish({ ...state, result: host.decorate(result) });
      }
      staged.notify();
    };
  };
  const reconcile = (
    row: GatewaySessionRow | undefined,
    defaults?: SessionsListResult["defaults"],
    options?: SessionReconcileOptions & { sourceCanonicalListRevision?: number },
    observation?: ReturnType<Host["roster"]["captureReconciliation"]>,
  ): boolean => {
    const state = host.readState();
    const historyAgentId =
      row?.agentId ??
      (isUiGlobalSessionKey(row?.key) ? options?.selectedGlobalAgentId : undefined) ??
      options?.resultAgentId ??
      state.agentId;
    if (observation && !observation.isCurrent(row, historyAgentId)) {
      return false;
    }
    const rowIsCurrent =
      Boolean(observation) || !row || host.roster.isCurrentRow(row, undefined, historyAgentId);
    // Cached rows can still enrich defaults through a current primary row.
    // A newer managed observation must not be replaced with an older primary.
    if (
      !rowIsCurrent &&
      !state.result?.sessions.some(
        (canonical) =>
          areUiSessionKeysEquivalent(canonical.key, row?.key) &&
          host.roster.isCurrentRow(canonical),
      )
    ) {
      return false;
    }
    if (
      row &&
      (!host.deletions.acceptsGeneration(row.key, row.sessionId, historyAgentId) ||
        host.deletions.deletionState(row.key, historyAgentId, row.sessionId))
    ) {
      return false;
    }
    const { sourceCanonicalListRevision, ...historyOptions } = options ?? {};
    const preserveCanonicalRow =
      !rowIsCurrent ||
      (!observation &&
        sourceCanonicalListRevision !== undefined &&
        host.canonicalListRevision() > sourceCanonicalListRevision);
    let observedKey: string | undefined;
    const normalized = reconcileSessionHistory(
      state.result,
      row,
      defaults,
      historyOptions,
      preserveCanonicalRow,
      row
        ? {
            observe: (accepted) => {
              observedKey = accepted.key;
            },
            isProvisional: (existing) =>
              state.resultCached === true &&
              (Boolean(observation) || host.roster.rowRevision(row) > 0) &&
              host.roster.rowRevision(existing) === 0,
            project: (accepted, donor) => {
              const select = observation?.observe(row, historyAgentId);
              const projected = projectRowFields(
                host.roster.inheritRow(accepted, row, donor),
                historyAgentId,
              );
              if (select) {
                host.mutations.observePendingFields(
                  row,
                  select(projected, pendingFields),
                  historyAgentId,
                );
              }
              return projected;
            },
          }
        : undefined,
    );
    const result = host.decorate(normalized);
    const accepted =
      observedKey &&
      result?.sessions.find((candidate) => areUiSessionKeysEquivalent(candidate.key, observedKey));
    const notify = accepted ? observation?.stage(accepted, historyAgentId) : undefined;
    if (accepted) {
      host.githubPublication.observeRows([accepted], historyAgentId);
    }
    const agentId = options?.resultAgentId?.trim()
      ? normalizeAgentId(options.resultAgentId)
      : state.agentId;
    // Ownership can change without changing any rows; subscribers need both.
    const rowsChanged = result?.sessions !== state.result?.sessions;
    if (result !== state.result || agentId !== state.agentId) {
      host.publish({ ...state, result, agentId });
    }
    notify?.();
    if (row && rowIsCurrent && rowsChanged) {
      host.roster.invalidateManagedLists(parseAgentSessionKey(row.key)?.agentId ?? historyAgentId);
    }
    return rowIsCurrent;
  };

  const observeRow: SessionCapability["observeRow"] = (target, listener) => {
    const { roster, deletions } = host;
    if (!target.key.trim() || !target.agentId.trim()) {
      throw new Error("A session row observation requires a session key and explicit agent.");
    }
    const owned = { key: target.key.trim(), agentId: normalizeAgentId(target.agentId) };
    const registration = roster.registerRow(owned, listener, {
      isValid: (sessionId) => deletions.acceptsGeneration(owned.key, sessionId, owned.agentId),
      decorate: (row) =>
        deletions.deletionState(row.key, owned.agentId, row.sessionId)
          ? null
          : host.mutations.applyPendingRow(
              host.permissions.applyRow(row, roster.rowRevision(row), owned.agentId),
              owned.agentId,
            ),
    });
    const held = roster.publishedRow((row, agentId) => {
      const sourceAgentId = parseAgentSessionKey(row.key)?.agentId ?? row.agentId ?? agentId;
      return Boolean(
        sourceAgentId &&
        areUiSessionKeysEquivalent(row.key, owned.key) &&
        normalizeAgentId(sourceAgentId) === owned.agentId &&
        roster.hasLiveObservation(row) &&
        deletions.acceptsGeneration(row.key, row.sessionId, owned.agentId),
      );
    });
    if (held) {
      roster.stageObservedRows([held], host.connection.capture(), owned.agentId)();
    }
    return {
      get row() {
        return registration.current();
      },
      isCurrent: registration.isCurrent,
      dispose: registration.dispose,
      captureReconcile() {
        const captured = roster.captureReconciliation();
        return (row) => {
          if (!registration.isCurrent() || !captured.isCurrent(undefined, owned.agentId)) {
            return { status: "retired" };
          }
          if (registration.readInvalidated(captured.revision)) {
            return { status: "invalidated" };
          }
          if (!row) {
            registration.clear(captured.revision)();
            return registration.isCurrent()
              ? { status: "current", row: registration.current() }
              : { status: "retired" };
          }
          if (
            !registration.acceptsRead(row, captured.revision) ||
            deletions.deletionState(row.key, owned.agentId, row.sessionId) ||
            !captured.isCurrent(row, owned.agentId)
          ) {
            return { status: "current", row: registration.current() };
          }
          const previous = roster.currentRow(row, owned.agentId);
          const reduced = reconcileSessionRow(
            row,
            previous,
            {
              resultAgentId: owned.agentId,
              selectedGlobalAgentId: owned.agentId,
              archivedFilter: "all",
            },
            {
              isProvisional: (existing) => roster.rowRevision(existing) === 0,
              project: (accepted, donor) => {
                const select = captured.observe(row, owned.agentId);
                const projected = projectRowFields(
                  roster.inheritRow(accepted, row, donor),
                  owned.agentId,
                );
                host.mutations.observePendingFields(
                  row,
                  select(projected, pendingFields),
                  owned.agentId,
                );
                return projected;
              },
            },
          );
          if (reduced.admittedRow) {
            const accepted = reduced.admittedRow;
            const notify = captured.stage(accepted, owned.agentId);
            const state = host.readState();
            const result = roster.mergeRows(state.result, [accepted], state.agentId, owned.agentId);
            host.githubPublication.observeRows([accepted], owned.agentId);
            if (result !== state.result) {
              host.publish({ ...state, result: host.decorate(result) });
            }
            notify();
          }
          return registration.isCurrent()
            ? { status: "current", row: registration.current() }
            : { status: "retired" };
        };
      },
    };
  };

  const reconcileChangedEvent = (
    payload: unknown,
    options?: SessionReconcileOptions,
    eventObservation = host.roster.captureEvent(payload),
  ) => {
    const {
      roster,
      connection,
      deletions,
      githubPublication,
      permissions,
      mutations,
      thinkingClaims,
    } = host;
    const state = host.readState();
    const eventIsCurrent = () =>
      !eventObservation.scope || connection.isCurrent(eventObservation.scope);
    const staleEvent = () => {
      const reconciled: SessionChangedResult = { applied: false, result: host.readState().result };
      return { eventInfo: null, reconciled, claimChanged: false, notifyManaged: undefined };
    };
    if (!eventIsCurrent()) {
      return staleEvent();
    }
    const previous = state.result;
    const eventInfo = readSessionChangedEvent(payload);
    if (
      eventInfo &&
      !deletions.acceptsGeneration(
        eventInfo.key,
        eventInfo.sessionId,
        eventInfo.agentId ?? state.agentId,
      )
    ) {
      return staleEvent();
    }
    githubPublication.observeEvent(payload);
    const selectedSessionKey = host.snapshot().sessionKey?.trim();
    const archivesSelectedSession =
      eventInfo?.archived === true &&
      Boolean(
        selectedSessionKey &&
        uiSessionEventMatches(
          {
            assistantAgentId: host.snapshot().assistantAgentId,
            hello: host.snapshot().hello,
            sessionKey: selectedSessionKey,
          },
          eventInfo.key,
          eventInfo.agentId,
        ),
      );
    // The capability owns the shared roster, so every event consumer must
    // preserve the routed archive regardless of subscriber delivery order.
    const reconcileOptions = archivesSelectedSession
      ? { ...options, archivedFilter: "all" as const }
      : options;
    let acceptedResult:
      | Pick<SessionChangedResult, "applied" | "key" | "row" | "deletedKey">
      | undefined;
    const projectEventFields = (
      admitted: GatewaySessionRow,
      previousRow: GatewaySessionRow,
      fields: readonly string[],
      ownerAgentId: string | null,
    ) => {
      const corrected = eventInfo?.hasPermissionMode
        ? permissions.observeEventRow(admitted, previousRow, eventInfo, ownerAgentId)
        : admitted;
      roster.inheritRow(corrected, previousRow);
      const source = roster.inheritRow({ ...corrected }, corrected);
      const select = roster.observeEvent(
        source,
        fields,
        eventObservation.revision,
        eventInfo?.updatedAt ?? null,
        ownerAgentId,
      );
      const projected = projectRowFields(source, ownerAgentId);
      mutations.observePendingFields(source, select(projected, pendingFields), ownerAgentId);
      return projected;
    };
    const reconcileResult = (
      held: SessionsListResult | null,
      ownerOptions: SessionReconcileOptions | undefined,
      ownerAgentId: string | null,
    ) => {
      const rows = roster.projectRows(held?.sessions ?? []);
      const current =
        held && rows.some((row, index) => row !== held.sessions[index])
          ? { ...held, sessions: rows }
          : held;
      const result = reconcileSessionChanged(
        current,
        payload,
        ownerOptions,
        (row, previousRow, fields) =>
          projectEventFields(row, previousRow, fields, eventInfo?.agentId ?? ownerAgentId),
      );
      roster.inherit(result.result, current, undefined, ownerAgentId);
      const removed =
        current && result.result && result.result.sessions.length < current.sessions.length;
      if (result.admittedRow || removed) {
        // A primary admission keeps its claim policy; managed-only members must
        // not be mistaken for a created row that no list has observed yet.
        acceptedResult ??= result;
        if (result.key && eventInfo) {
          mutations.observeArchiveState(
            result.key,
            eventInfo.archived === null ? null : result.admittedRow?.archived === true,
            result.admittedRow,
          );
        }
      }
      return result;
    };
    const reconciled = reconcileResult(previous, reconcileOptions, state.agentId);
    const managedAdmissions: Array<{ row: GatewaySessionRow; revision: number }> = [];
    const staged = roster.stageManagedResults(
      eventObservation.scope,
      (entry) => {
        const result = reconcileResult(
          entry.snapshot.result,
          {
            resultAgentId: entry.snapshot.agentId,
            archivedFilter: archivesSelectedSession ? "all" : entry.scope.archivedFilter,
          },
          entry.snapshot.agentId,
        );
        if (result.admittedRow) {
          managedAdmissions.push({ row: result.admittedRow, revision: eventObservation.revision });
        }
        return result.result;
      },
      (entry) => {
        const eventAgentId = eventInfo?.agentId ?? parseAgentSessionKey(eventInfo?.key)?.agentId;
        if (
          !eventInfo ||
          !eventAgentId ||
          !areUiSessionKeysEquivalent(eventInfo.key, entry.target.key) ||
          normalizeAgentId(eventAgentId) !== entry.target.agentId
        ) {
          return { row: entry.row };
        }
        if (!entry.row) {
          return { row: null, invalidateRevision: eventObservation.revision };
        }
        if (eventInfo.sessionId && eventInfo.sessionId !== entry.row.sessionId) {
          return { row: entry.row };
        }
        const current = roster.projectFields(entry.row, entry.target.agentId);
        const reduced = reconcileSessionChangedRow(
          current,
          payload,
          {
            resultAgentId: entry.target.agentId,
            selectedGlobalAgentId: entry.target.agentId,
            archivedFilter: "all",
          },
          (row, previousRow, fields) =>
            projectEventFields(row, previousRow, fields, entry.target.agentId),
        );
        if (reduced.admittedRow || reduced.deletedKey) {
          acceptedResult ??= reduced;
        }
        return { row: reduced.row ?? null };
      },
      false,
      managedAdmissions,
    );
    const notifyManaged = (primaryPublished = false) =>
      staged.notify(
        primaryPublished && reconciled.admittedRow
          ? [{ row: reconciled.admittedRow, revision: eventObservation.revision }]
          : [],
      );
    const claimChanged = thinkingClaims.observeEvent(
      eventInfo?.reason === "delete" ? reconciled : (acceptedResult ?? reconciled),
      eventInfo,
    );
    if (
      eventInfo &&
      (eventInfo.reason !== "delete" || reconciled.deletedKey || !eventInfo.sessionId)
    ) {
      deletions.observe(eventInfo);
    }
    if (!eventIsCurrent()) {
      return staleEvent();
    }
    return { eventInfo, reconciled, claimChanged, notifyManaged };
  };

  return {
    capturePatchFields,
    reconcile,
    reconcileChangedEvent,
    observeRow,
    captureReconcile(this: void): SessionCapability["reconcile"] {
      const observation = host.roster.captureReconciliation();
      return (row, defaults, options) => reconcile(row, defaults, options, observation);
    },
  };
}
