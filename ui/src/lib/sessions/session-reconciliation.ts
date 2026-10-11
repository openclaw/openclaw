import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { GatewayEventFrame } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import {
  projectSessionResultRows,
  mapSessionResultRows,
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
import { optimisticSessionRowFields, type SessionPatchRowFact } from "./session-pending-rows.ts";
import type { createSessionPermissionProjection } from "./session-permission-projection.ts";
import type { createSessionRosterRefresh } from "./session-roster-refresh.ts";
import { sessionChangedSnapshots, type SessionChangedEventInfo } from "./session-row-reconcile.ts";
import type { createSessionThinkingClaims } from "./session-thinking-claims.ts";

type Host = {
  readState: () => SessionState;
  publish: (state: SessionState) => void;
  connection: SessionConnectionOwner;
  snapshot: () => SessionGateway["snapshot"];
  permissions: Pick<
    ReturnType<typeof createSessionPermissionProjection>,
    "observeEventRow" | "applyRow" | "reconcileRow"
  >;
  mutations: Pick<
    ReturnType<typeof createSessionMutations>,
    "observeArchiveState" | "confirmArchiveState" | "applyRow" | "observePendingFields"
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
    "captureReconciliation" | "invalidateManagedLists" | "observations"
  >;
};

export function createSessionReconciliation(host: Host) {
  const pendingFields = optimisticSessionRowFields;
  const createReadRowProjection =
    (
      row: GatewaySessionRow,
      observation: ReturnType<Host["roster"]["captureReconciliation"]> | undefined,
      agentId: string | null,
    ) =>
    (accepted: GatewaySessionRow) => {
      const alreadyObserved = host.roster.observations.hasLiveObservation(row);
      observation?.observe(row, agentId);
      const inherited = host.roster.observations.inheritRow(accepted, row);
      const projected = host.roster.observations.projectFields(
        observation
          ? host.permissions.reconcileRow(inherited, observation.revision, agentId)
          : inherited,
        agentId,
      );
      if (observation && !alreadyObserved) {
        host.mutations.observePendingFields(
          row,
          row.rowMode === "compact"
            ? pendingFields.filter((field) => Object.hasOwn(row, field))
            : pendingFields,
          agentId,
        );
      }
      return projected;
    };
  const capturePatchFields = (target: SessionRowTarget & { sessionId: string }) => {
    const captured = host.roster.captureReconciliation();
    const owned = { ...target, key: target.key.trim(), agentId: normalizeAgentId(target.agentId) };
    const validTarget = Boolean(owned.key && target.agentId.trim() && owned.sessionId.trim());
    return (fact: SessionPatchRowFact): void => {
      const current = () =>
        captured.isCurrent() &&
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
      const observed = host.roster.observations.observedRow(owned.key, owned.agentId);
      if (
        observed?.sessionId === owned.sessionId &&
        fact.updatedAt !== null &&
        observed.updatedAt != null &&
        fact.updatedAt < observed.updatedAt
      ) {
        return;
      }
      const fields = Object.keys(fact.fields);
      let matchedArchiveRow = false;
      let archiveChanged = false;
      const confirmArchive = (
        row: Pick<GatewaySessionRow, "archived" | "archivedAt" | "archivedBy" | "archiveReason">,
      ) => {
        archiveChanged =
          host.mutations.confirmArchiveState(owned.key, row.archived === true, {
            sessionId: owned.sessionId,
            archivedAt: row.archivedAt,
            archivedBy: row.archivedBy,
            archiveReason: row.archiveReason,
            updatedAt: fact.updatedAt,
          }) || archiveChanged;
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
        const source = {
          ...row,
          ...fact.fields,
          ...(fact.updatedAt !== null ? { updatedAt: fact.updatedAt } : {}),
        };
        host.roster.observations.inheritRow(source, row);
        host.roster.observations.observeReadRow(
          source,
          Math.max(captured.revision, fact.readCutoff ?? 0),
          owned.agentId,
        );
        host.roster.observations.observeClears(source, fields);
        const projected = source;
        if ("archived" in fact.fields) {
          matchedArchiveRow = true;
          confirmArchive(projected);
        }
        host.mutations.observePendingFields(
          source,
          fields.filter((field) => pendingFields.some((name) => name === field)),
          owned.agentId,
        );
        return projected;
      };
      const reconcileResult = (result: SessionsListResult | null, agentId?: string | null) =>
        mapSessionResultRows(result, (row) => reconcileRow(row, agentId));
      const state = host.readState();
      const result = reconcileResult(state.result, state.agentId);
      const staged = host.roster.observations.stageManagedResults(
        captured.scope,
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
        confirmArchive(fact.fields);
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
    if (observation && !observation.isCurrent()) {
      return false;
    }
    if (
      row &&
      (!host.deletions.acceptsGeneration(row.key, row.sessionId, historyAgentId) ||
        host.deletions.deletionState(row.key, historyAgentId, row.sessionId))
    ) {
      return false;
    }
    const projectReadRow = row && createReadRowProjection(row, observation, historyAgentId);
    let observedKey: string | undefined;
    const normalized = reconcileSessionHistory(
      state.result,
      row,
      defaults,
      options,
      false,
      row
        ? {
            observe: (accepted) => {
              observedKey = accepted.key;
            },
            isProvisional: (existing) =>
              state.resultCached === true &&
              (Boolean(observation) || host.roster.observations.rowRevision(row) > 0) &&
              host.roster.observations.rowRevision(existing) === 0,
            project: projectReadRow,
          }
        : undefined,
    );
    const result = host.decorate(normalized);
    const accepted =
      observedKey &&
      result?.sessions.find((candidate) => areUiSessionKeysEquivalent(candidate.key, observedKey));
    // A pane can hold another agent's global descriptor outside the primary roster.
    // Its read still uses the observation captured before I/O and never grants list membership.
    const observed =
      accepted ||
      (row && observation
        ? reconcileSessionRow(
            row,
            host.roster.observations.currentRow(row, historyAgentId),
            {
              resultAgentId: historyAgentId,
              selectedGlobalAgentId: historyAgentId,
              archivedFilter: "all",
            },
            { project: projectReadRow },
          ).admittedRow
        : undefined);
    const notify = observed ? observation?.stage(observed, historyAgentId) : undefined;
    if (observed) {
      host.githubPublication.observeRows([observed], historyAgentId);
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
    // Cached lineage reuses held rows and must not invalidate their supplying lists.
    if (row && rowsChanged) {
      host.roster.invalidateManagedLists(
        parseAgentSessionKey(row.key)?.agentId ?? historyAgentId,
        accepted || row,
        options?.sourceListScope,
      );
    }
    return true;
  };

  const observeRow: SessionCapability["observeRow"] = (target, listener, options) => {
    const { roster, deletions } = host;
    if (!target.key.trim() || !target.agentId.trim()) {
      throw new Error("A session row observation requires a session key and explicit agent.");
    }
    const owned = { key: target.key.trim(), agentId: normalizeAgentId(target.agentId) };
    const registration = roster.observations.registerRow(owned, listener, {
      onInvalidate: options?.onInvalidate,
      onEvent: options?.onEvent,
      isValid: (sessionId) => deletions.acceptsGeneration(owned.key, sessionId, owned.agentId),
      decorate: (row) =>
        deletions.deletionState(row.key, owned.agentId, row.sessionId)
          ? null
          : host.mutations.applyRow(
              host.permissions.applyRow(row, roster.observations.rowRevision(row), owned.agentId),
              owned.agentId,
            ),
    });
    const held = roster.observations.publishedRow((row, agentId) => {
      const sourceAgentId = parseAgentSessionKey(row.key)?.agentId ?? row.agentId ?? agentId;
      return Boolean(
        sourceAgentId &&
        areUiSessionKeysEquivalent(row.key, owned.key) &&
        normalizeAgentId(sourceAgentId) === owned.agentId &&
        roster.observations.hasLiveObservation(row) &&
        deletions.acceptsGeneration(row.key, row.sessionId, owned.agentId),
      );
    });
    if (held) {
      roster.observations.stageObservedRows([held], host.connection.capture(), owned.agentId)();
    }
    return {
      get row() {
        return registration.current();
      },
      get sessionId() {
        return registration.sessionId();
      },
      get hasObserved() {
        return registration.hasObserved();
      },
      isCurrent: registration.isCurrent,
      dispose: registration.dispose,
      captureReconcile() {
        const captured = roster.captureReconciliation();
        return (row) => {
          if (!registration.isCurrent() || !captured.isCurrent()) {
            return { status: "retired" };
          }
          if (row) {
            if (
              !registration.acceptsRead(row) ||
              deletions.deletionState(row.key, owned.agentId, row.sessionId) ||
              !captured.isCurrent()
            ) {
              return { status: "current", row: registration.current() };
            }
            const previous = roster.observations.currentRow(row, owned.agentId);
            const reduced = reconcileSessionRow(
              row,
              previous,
              {
                resultAgentId: owned.agentId,
                selectedGlobalAgentId: owned.agentId,
                archivedFilter: "all",
              },
              {
                isProvisional: (existing) => roster.observations.rowRevision(existing) === 0,
                project: createReadRowProjection(row, captured, owned.agentId),
              },
            );
            if (reduced.admittedRow) {
              const accepted = reduced.admittedRow;
              const notify = captured.stage(accepted, owned.agentId);
              const state = host.readState();
              const result = roster.observations.mergeRows(
                state.result,
                [accepted],
                state.agentId,
                owned.agentId,
              );
              host.githubPublication.observeRows([accepted], owned.agentId);
              if (result !== state.result) {
                host.publish({ ...state, result: host.decorate(result) });
              }
              notify();
            }
          } else {
            registration.clear()();
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
    eventObservation: ReturnType<ReturnType<typeof createSessionRosterRefresh>["captureEvent"]>,
    options?: SessionReconcileOptions,
  ): {
    eventInfo: ReturnType<typeof readSessionChangedEvent>;
    reconciled: SessionChangedResult;
    claimChanged?: boolean;
    notifyManaged?: (primaryPublished?: boolean) => void;
    notifyEvent?: (event: GatewayEventFrame) => void;
  } => {
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
    const eventInfo = readSessionChangedEvent(payload);
    const eventIsCurrent = () =>
      (!eventObservation.scope || connection.isCurrent(eventObservation.scope)) &&
      (!eventInfo ||
        deletions.acceptsGeneration(
          eventInfo.key,
          eventInfo.sessionId,
          eventInfo.agentId ?? state.agentId,
        ));
    const notifyEvent = (event: GatewayEventFrame) =>
      eventObservation.deliver(event, eventIsCurrent);
    const staleEvent = () => {
      const reconciled: SessionChangedResult = { applied: false, result: host.readState().result };
      return {
        eventInfo: null,
        reconciled,
        notifyEvent,
      };
    };
    if (!eventIsCurrent()) {
      return staleEvent();
    }
    const previous = state.result;
    const invalidationReason = normalizeOptionalString(asNullableRecord(payload)?.reason);
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
    let admittedDescriptorResult:
      | Pick<SessionChangedResult, "applied" | "key" | "row" | "deletedKey">
      | undefined;
    let admittedRosterResult: Omit<SessionChangedResult, "result"> | undefined;
    const projection = roster.observations.prepareProjection();
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
      roster.observations.inheritRow(corrected, previousRow);
      const source = roster.observations.inheritRow({ ...corrected }, corrected);
      roster.observations.observeReadRow(source, eventObservation.revision, ownerAgentId);
      roster.observations.observeClears(source, fields);
      const projected = projection.projectFields(source, ownerAgentId);
      if (rowInfo.archived !== null || fields.includes("archived")) {
        mutations.observeArchiveState(projected.key, projected.archived === true, projected);
      }
      mutations.observePendingFields(
        source,
        fields.filter((field) => pendingFields.some((name) => name === field)),
        ownerAgentId,
      );
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
      roster.observations.inherit(result.result, current, ownerAgentId);
      if (!admittedRosterResult && result.admittedRow) {
        // Roster admission owns claim policy before descriptor-only evidence.
        const { result: _result, ...facts } = result;
        admittedRosterResult = facts;
      }
      return result;
    };
    const reconciled = reconcileResult(previous, reconcileOptions, state.agentId);
    const staged = roster.observations.stageManagedResults(
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
        return result.result;
      },
      (entry) => {
        if (!eventInfo && invalidationReason === "runner-availability") {
          return { row: entry.row, invalidate: "now" };
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
          // A roster can admit this frame while the descriptor's first read is pending.
          return {
            row: null,
            eventResult: admittedRosterResult,
            invalidate: "now",
          };
        }
        if (rowInfo.sessionId && rowInfo.sessionId !== entry.row.sessionId) {
          return {
            row: entry.row,
            retire: rowInfo.updatedAt !== null && rowInfo.updatedAt >= (entry.row.updatedAt ?? 0),
          };
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
          admittedDescriptorResult ??= reduced;
        }
        return {
          row: reduced.row ?? null,
          eventResult: reduced,
          ...(!reduced.deletedKey &&
          (!reduced.admittedRow || !Array.isArray(asNullableRecord(snapshot)?.ancestorSessions))
            ? {
                invalidate:
                  reduced.admittedRow && asNullableRecord(asNullableRecord(snapshot)?.session)
                    ? ("later" as const)
                    : ("now" as const),
              }
            : {}),
        };
      },
      eventObservation,
      invalidationReason,
    );
    const notifyManaged = () => staged.notify();
    const claimChanged = thinkingClaims.observeEvent(
      eventInfo?.reason === "delete"
        ? reconciled
        : (admittedRosterResult ?? admittedDescriptorResult ?? reconciled),
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
    return {
      eventInfo,
      reconciled,
      claimChanged,
      notifyManaged,
      notifyEvent,
    };
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
