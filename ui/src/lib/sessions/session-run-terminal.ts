import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { GatewaySessionRow, SessionRunStatus, SessionsListResult } from "../../api/types.ts";
import { formatUiExternalText } from "../format-error.ts";
import type { GatewayConnectionScope } from "../gateway-connection-lifecycle.ts";
import { isSessionRunActive } from "../session-run-state.ts";
import { projectSessionResultRows } from "./reconcile.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "./session-key.ts";
import {
  createSessionWriteObservation,
  type createSessionRowProvenance,
} from "./session-row-provenance.ts";

export type SessionRunTerminal = {
  sessionKeys: readonly string[];
  agentId?: string;
  runId?: string | null;
  /** Latest session status after this owned model run leaves the active registry. */
  status: SessionRunStatus;
  errorMessage?: string;
  endedAt: number;
};

type SessionRunTerminalObservation = {
  agentId: (row: GatewaySessionRow) => string | null;
  project: (row: GatewaySessionRow) => GatewaySessionRow;
  observe: (row: GatewaySessionRow, previous: GatewaySessionRow, fields: readonly string[]) => void;
};

function createSessionRunTerminalReconciler(
  terminal: SessionRunTerminal,
  observation?: SessionRunTerminalObservation,
): (row: GatewaySessionRow) => GatewaySessionRow {
  const runId = terminal.runId?.trim() || null;
  // Match the Gateway's compact session error projection, redacting before truncation.
  const errorMessage = truncateUtf16Safe(
    formatUiExternalText(terminal.errorMessage).replace(/\s+/g, " ").trim(),
    160,
  );
  return (existing) => {
    if (!terminal.sessionKeys.some((key) => areUiSessionKeysEquivalent(existing.key, key))) {
      return existing;
    }
    const agentId = observation
      ? observation.agentId(existing)
      : (existing.agentId ?? terminal.agentId);
    if (
      isUiGlobalSessionKey(existing.key) &&
      (!terminal.agentId ||
        !agentId ||
        normalizeAgentId(agentId) !== normalizeAgentId(terminal.agentId))
    ) {
      return existing;
    }
    const row = observation?.project(existing) ?? existing;
    const wasActive = row.hasActiveRun === true || isSessionRunActive(row);
    const previousTerminalRunId = row.lastRunId?.trim();
    const isTerminal = terminal.status !== "queued" && terminal.status !== "running";
    // An idle tuple may predate this run or belong to a newer completion.
    if (
      !wasActive &&
      isTerminal &&
      runId &&
      previousTerminalRunId &&
      previousTerminalRunId !== runId
    ) {
      return existing;
    }
    if (wasActive) {
      // Active identity belongs to the originating model run, not a newer overlap.
      if (!runId || !row.activeRunIds?.includes(runId)) {
        return existing;
      }
    }
    const remainingRunIds = runId ? row.activeRunIds?.filter((id) => id !== runId) : [];
    if (remainingRunIds?.length) {
      const next = {
        ...row,
        activeRunIds: remainingRunIds,
        hasActiveRun: true,
        status: "running" as const,
      };
      observation?.observe(next, row, ["activeRunIds", "hasActiveRun", "status"]);
      return next;
    }
    // Exact active ownership can precede the persisted lifecycle update. Replace
    // the older terminal tuple without guessing the current run's start time.
    const replacementRunId =
      wasActive && runId && previousTerminalRunId && previousTerminalRunId !== runId && isTerminal
        ? runId
        : undefined;
    const failed = terminal.status === "failed" || terminal.status === "timeout";
    const lastRunError = failed
      ? errorMessage || (replacementRunId ? undefined : row.lastRunError)
      : undefined;
    const endedAt = replacementRunId ? terminal.endedAt : (row.endedAt ?? terminal.endedAt);
    const runtimeMs = replacementRunId
      ? undefined
      : typeof row.startedAt === "number"
        ? Math.max(0, endedAt - row.startedAt)
        : row.runtimeMs;
    const activeRunIds = row.activeRunIds?.length ? [] : row.activeRunIds;
    const abortedLastRun =
      terminal.status === "killed"
        ? true
        : replacementRunId || terminal.status === "running"
          ? false
          : row.abortedLastRun;
    const fields = ["hasActiveRun", "status"];
    if (activeRunIds !== undefined) {
      fields.push("activeRunIds");
    }
    if (!failed || errorMessage || replacementRunId) {
      fields.push("lastRunError");
    }
    if (replacementRunId) {
      fields.push("lastRunId", "startedAt", "endedAt", "runtimeMs");
    } else if (row.endedAt == null) {
      fields.push("endedAt");
      if (typeof row.startedAt === "number") {
        fields.push("runtimeMs");
      }
    }
    if (replacementRunId || terminal.status === "killed" || terminal.status === "running") {
      fields.push("abortedLastRun");
    }
    const next =
      !replacementRunId &&
      row.hasActiveRun === false &&
      row.status === terminal.status &&
      row.lastRunError === lastRunError &&
      row.endedAt === endedAt &&
      row.runtimeMs === runtimeMs &&
      row.activeRunIds === activeRunIds &&
      row.abortedLastRun === abortedLastRun
        ? row
        : {
            ...row,
            ...(replacementRunId ? { lastRunId: replacementRunId, startedAt: undefined } : {}),
            activeRunIds,
            hasActiveRun: false,
            status: terminal.status,
            lastRunError,
            endedAt,
            runtimeMs,
            abortedLastRun,
          };
    // Same-value terminal facts still precede an already-issued list response.
    observation?.observe(next, row, fields);
    return next;
  };
}

export function reconcileSessionRunTerminal(
  result: SessionsListResult | null,
  terminal: SessionRunTerminal,
  observation?: SessionRunTerminalObservation,
): SessionsListResult | null {
  if (!result) {
    return result;
  }
  const reconcileRow = createSessionRunTerminalReconciler(terminal, observation);
  return projectSessionResultRows(result, result.sessions.map(reconcileRow));
}

type SessionTerminalRosterState = {
  result: SessionsListResult | null;
  agentId: string | null;
};

type SessionTerminalRosterHost = {
  readState: () => SessionTerminalRosterState;
  prepareProjection: () => {
    projectFields: (row: GatewaySessionRow, agentId: string | null) => GatewaySessionRow;
  };
  provenance: Pick<
    ReturnType<typeof createSessionRowProvenance>,
    "owner" | "inheritRow" | "observeFields"
  >;
  stage: (
    scope: GatewayConnectionScope | null,
    projectList: (entry: { snapshot: SessionTerminalRosterState }) => SessionsListResult | null,
    projectRow: (entry: {
      target: Readonly<{ key: string; agentId: string }>;
      row: GatewaySessionRow | null;
    }) => {
      row: GatewaySessionRow | null;
      invalidateRevision?: number;
    },
  ) => { changed: boolean; notify: () => void };
};

export function createSessionRunTerminalStaging(host: SessionTerminalRosterHost) {
  return (
    terminal: SessionRunTerminal,
    event: { scope: GatewayConnectionScope | null; revision: number },
  ): { result: SessionsListResult | null; changed: boolean; notify: () => void } => {
    const { owner, inheritRow, observeFields } = host.provenance;
    const { projectFields: project } = host.prepareProjection();
    const observation = (agentId: string | null): SessionRunTerminalObservation => ({
      agentId: (row) => owner(row, agentId),
      project: (row) => project(row, agentId),
      observe: (row, source, fields) => {
        inheritRow(row, source);
        // Terminal time is local; only Gateway rows supply the updatedAt clock.
        observeFields(row, fields, createSessionWriteObservation(event.revision, null), agentId);
      },
    });
    const reconcile = (result: SessionsListResult | null, agentId: string | null) =>
      result && reconcileSessionRunTerminal(result, terminal, observation(agentId));
    const state = host.readState();
    const result = reconcile(state.result, state.agentId);
    // Compute every owner against the unchanged held rows: consuming an overlap
    // in one window must not make another reject the same completed run.
    const staged = host.stage(
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
          row:
            entry.row && matches
              ? createSessionRunTerminalReconciler(
                  terminal,
                  observation(entry.target.agentId),
                )(entry.row)
              : entry.row,
          ...(!entry.row && matches ? { invalidateRevision: event.revision } : {}),
        };
      },
    );
    return { result, changed: result !== state.result || staged.changed, notify: staged.notify };
  };
}
