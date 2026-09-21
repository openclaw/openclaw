import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import {
  projectSessionResultRows,
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
import { createSessionWriteObservation, type FieldObservation } from "./session-row-provenance.ts";
import {
  isOlderSessionSnapshot,
  sessionChangedSnapshots,
  type SessionChangedEventInfo,
} from "./session-row-reconcile.ts";
import type { createSessionThinkingClaims } from "./session-thinking-claims.ts";

type Host = {
  readState: () => SessionState;
  publish: (state: SessionState) => void;
  canonicalListRevision: () => number;
  connection: SessionConnectionOwner;
  snapshot: () => SessionGateway["snapshot"];
  permissions: Pick<
    ReturnType<typeof createSessionPermissionProjection>,
    "observeEventRow" | "applyRow" | "reconcileRow"
  >;
  mutations: Pick<
    ReturnType<typeof createSessionMutations>,
    | "observeArchiveState"
    | "confirmArchiveState"
    | "applyPendingRow"
    | "observePendingFields"
    | "applyConfirmedArchiveRow"
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
    | "observeFields"
    | "stageManagedResults"
    | "prepareProjection"
    | "invalidateManagedLists"
    | "inheritRow"
    | "isCurrentRow"
    | "rowRevision"
    | "hasLiveObservation"
    | "projectFields"
    | "fieldObservation"
  >;
};

export function createSessionReconciliation(host: Host) {
  const pendingFields = ["pinned", "pinnedAt", "unread", "category"] as const;
  const projectRowFields = (
    row: GatewaySessionRow,
    agentId?: string | null,
    project = host.roster.projectFields,
  ) => {
    const projected = project(row, agentId);
    return projected.key === row.key
      ? projected
      : host.roster.inheritRow({ ...projected, key: row.key }, projected);
  };
  const projectReadRow = (
    accepted: GatewaySessionRow,
    donor: GatewaySessionRow | undefined,
    source: GatewaySessionRow,
    agentId: string | null,
    observation?: ReturnType<Host["roster"]["captureReconciliation"]>,
  ) => {
    const select = observation?.observe(source, agentId);
    const inherited = host.roster.inheritRow(accepted, source, donor);
    const projected = projectRowFields(
      observation
        ? host.permissions.reconcileRow(inherited, observation.revision, agentId)
        : inherited,
      agentId,
    );
    if (select) {
      host.mutations.observePendingFields(source, select(projected, pendingFields), agentId);
    }
    return projected;
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
      const observation = createSessionWriteObservation(
        captured.revision,
        fact.updatedAt,
        fact.readCutoff,
      );
      let matchedArchiveRow = false;
      let archiveChanged = false;
      const confirmArchive = (
        row: Pick<GatewaySessionRow, "archived" | "archivedAt" | "archivedBy" | "archiveReason">,
        projectedObservation: FieldObservation,
      ) => {
        archiveChanged =
          host.mutations.confirmArchiveState(
            owned.key,
            row.archived === true,
            {
              sessionId: owned.sessionId,
              archivedAt: row.archivedAt,
              archivedBy: row.archivedBy,
              archiveReason: row.archiveReason,
            },
            projectedObservation,
          ) || archiveChanged;
      };
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
        const select = host.roster.observeFields(source, fields, observation, owned.agentId);
        const projected = projectRowFields(source, owned.agentId);
        if ("archived" in fact.fields) {
          matchedArchiveRow = true;
          // Field provenance may prefer a newer restore over this acknowledgement.
          confirmArchive(projected, host.roster.fieldObservation(projected, "archived"));
        }
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
        return projectSessionResultRows(
          result,
          result.sessions.map((row) => reconcileRow(row, agentId)),
        );
      };
      const state = host.readState();
      const result = reconcileResult(state.result, state.agentId);
      const staged = host.roster.stageManagedResults(
        scope,
        (entry) => reconcileResult(entry.snapshot.result, entry.snapshot.agentId),
        (entry) => ({
          row: entry.row ? reconcileRow(entry.row, entry.target.agentId) : null,
        }),
      );
      if (!current()) {
        return;
      }
      if (!matchedArchiveRow && "archived" in fact.fields) {
        // An archived row may have left every list before its batch Undo returns.
        confirmArchive(fact.fields, observation);
      }
      if (result !== state.result || archiveChanged) {
        host.publish({ ...state, result: host.decorate(result) });
      }
      staged.notify();
    };
  };
  const reconcile = (
    row: GatewaySessionRow | undefined,
    defaults?: SessionsListResult["defaults"],
    options?: Parameters<SessionCapability["reconcile"]>[2],
    observation?: ReturnType<Host["roster"]["captureReconciliation"]>,
  ): ReturnType<SessionCapability["reconcile"]> => {
    const state = host.readState();
    const historyAgentId =
      row?.agentId ??
      (isUiGlobalSessionKey(row?.key) ? options?.selectedGlobalAgentId : undefined) ??
      options?.resultAgentId ??
      state.agentId;
    if (observation && !observation.isCurrent(undefined, historyAgentId)) {
      return false;
    }
    if (
      row &&
      (!host.deletions.acceptsGeneration(row.key, row.sessionId, historyAgentId) ||
        host.deletions.deletionState(row.key, historyAgentId, row.sessionId))
    ) {
      return false;
    }
    if (observation && !observation.isCurrent(row, historyAgentId)) {
      // A newer same-agent row does not retire this history's scoped defaults.
      // Admit only the pane's defaults after connection and generation checks;
      // never publish its stale row or defaults into another agent's roster.
      return defaults &&
        row &&
        isUiGlobalSessionKey(row.key) &&
        historyAgentId !== state.agentId &&
        options?.selectedGlobalAgentId === historyAgentId
        ? "defaults-only"
        : false;
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
    const sourceCanonicalListRevision = options?.sourceCanonicalListRevision;
    const preserveCanonicalRow =
      !rowIsCurrent ||
      (!observation &&
        sourceCanonicalListRevision !== undefined &&
        host.canonicalListRevision() > sourceCanonicalListRevision);
    let observedKey: string | undefined;
    // A descriptor can hold newer metadata even when its row is outside the primary page.
    const held = row ? host.roster.currentRow(row, historyAgentId) : undefined;
    const historyRow = row && isOlderSessionSnapshot(row, held) ? undefined : row;
    const normalized = reconcileSessionHistory(
      state.result,
      historyRow,
      defaults,
      options,
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
            project: (accepted, donor) =>
              projectReadRow(accepted, donor, row, historyAgentId, observation),
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
      host.roster.invalidateManagedLists(
        parseAgentSessionKey(row.key)?.agentId ?? historyAgentId,
        accepted || row,
        options?.sourceListScope,
      );
    }
    return rowIsCurrent;
  };

  const observeRow: SessionCapability["observeRow"] = (target, listener, options) => {
    const { roster, deletions } = host;
    if (!target.key.trim() || !target.agentId.trim()) {
      throw new Error("A session row observation requires a session key and explicit agent.");
    }
    const owned = { key: target.key.trim(), agentId: normalizeAgentId(target.agentId) };
    const registration = roster.registerRow(owned, listener, {
      onInvalidate: options?.onInvalidate,
      isValid: (sessionId) => deletions.acceptsGeneration(owned.key, sessionId, owned.agentId),
      decorate: (row) =>
        deletions.deletionState(row.key, owned.agentId, row.sessionId)
          ? null
          : host.mutations.applyPendingRow(
              host.mutations.applyConfirmedArchiveRow(
                host.permissions.applyRow(row, roster.rowRevision(row), owned.agentId),
              ),
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
              project: (accepted, donor) =>
                projectReadRow(accepted, donor, row, owned.agentId, captured),
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
    const invalidationReason = normalizeOptionalString(asNullableRecord(payload)?.reason);
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
    // Planning shares held rows; each merge still reads their current field receipts.
    const projection = roster.prepareProjection();
    const projectEventFields = (
      admitted: GatewaySessionRow,
      previousRow: GatewaySessionRow,
      fields: readonly string[],
      ownerAgentId: string | null,
      rowInfo: SessionChangedEventInfo,
    ) => {
      const corrected = rowInfo.hasPermissionMode
        ? permissions.observeEventRow(admitted, previousRow, rowInfo, ownerAgentId)
        : admitted;
      roster.inheritRow(corrected, previousRow);
      const source = roster.inheritRow({ ...corrected }, corrected);
      const select = roster.observeFields(
        source,
        fields,
        createSessionWriteObservation(
          eventObservation.revision,
          rowInfo.updatedAt,
          undefined,
          rowInfo.snapshotAt,
        ),
        ownerAgentId,
      );
      const projected = projectRowFields(source, ownerAgentId, projection.projectFields);
      if (rowInfo.archived !== null) {
        mutations.observeArchiveState(projected.key, projected.archived === true, projected);
      }
      mutations.observePendingFields(source, select(projected, pendingFields), ownerAgentId);
      return projected;
    };
    const reconcileResult = (
      held: SessionsListResult | null,
      ownerOptions: SessionReconcileOptions | undefined,
      ownerAgentId: string | null,
    ) => {
      const current = projectSessionResultRows(held, projection.projectRows(held?.sessions ?? []));
      const result = reconcileSessionChanged(
        current,
        payload,
        ownerOptions,
        (row, previousRow, fields, rowInfo) =>
          projectEventFields(row, previousRow, fields, rowInfo.agentId ?? ownerAgentId, rowInfo),
        (info) =>
          deletions.acceptsGeneration(info.key, info.sessionId, info.agentId ?? ownerAgentId),
      );
      roster.inherit(result.result, current, undefined, ownerAgentId);
      const removed =
        current && result.result && result.result.sessions.length < current.sessions.length;
      if (result.admittedRow || removed) {
        // A primary admission keeps its claim policy; managed-only members must
        // not be mistaken for a created row that no list has observed yet.
        acceptedResult ??= result;
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
        managedAdmissions.push(
          ...(result.admittedRows ?? []).map((row) => ({
            row,
            revision: eventObservation.revision,
          })),
        );
        return result.result;
      },
      (entry) => {
        if (!eventInfo && invalidationReason === "runner-availability") {
          return { row: entry.row, invalidateRevision: eventObservation.revision };
        }
        const snapshot = sessionChangedSnapshots(payload).find((candidate) => {
          const info = readSessionChangedEvent(candidate);
          const agentId = info?.agentId ?? parseAgentSessionKey(info?.key)?.agentId;
          return (
            info &&
            agentId &&
            areUiSessionKeysEquivalent(info.key, entry.target.key) &&
            normalizeAgentId(agentId) === entry.target.agentId &&
            deletions.acceptsGeneration(info.key, info.sessionId, agentId)
          );
        });
        const rowInfo = readSessionChangedEvent(snapshot);
        if (!rowInfo) {
          return { row: entry.row };
        }
        if (!entry.row) {
          return { row: null, invalidateRevision: eventObservation.revision };
        }
        if (rowInfo.sessionId && rowInfo.sessionId !== entry.row.sessionId) {
          return { row: entry.row };
        }
        const current = projection.projectFields(entry.row, entry.target.agentId);
        const reduced = reconcileSessionChangedRow(
          current,
          snapshot,
          {
            resultAgentId: entry.target.agentId,
            selectedGlobalAgentId: entry.target.agentId,
            archivedFilter: "all",
          },
          (row, previousRow, fields) =>
            projectEventFields(row, previousRow, fields, entry.target.agentId, rowInfo),
        );
        if (snapshot === payload && (reduced.admittedRow || reduced.deletedKey)) {
          acceptedResult ??= reduced;
        }
        return {
          row: reduced.row ?? null,
          ...(!reduced.deletedKey &&
          (!reduced.admittedRow || !Array.isArray(asNullableRecord(snapshot)?.ancestorSessions))
            ? { invalidateRevision: eventObservation.revision }
            : {}),
        };
      },
      false,
      managedAdmissions,
    );
    const notifyManaged = (primaryPublished = false) =>
      staged.notify(
        primaryPublished
          ? (reconciled.admittedRows ?? []).map((row) => ({
              row,
              revision: eventObservation.revision,
            }))
          : [],
        invalidationReason,
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
