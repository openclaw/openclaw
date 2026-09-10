import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { GatewaySessionRow, SessionRunStatus, SessionsListResult } from "../../api/types.ts";
import { formatUiExternalText } from "../format-error.ts";
import { isSessionRunActive } from "../session-run-state.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  normalizeAgentId,
} from "./session-key.ts";

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

export function createSessionRunTerminalReconciler(
  terminal: SessionRunTerminal,
  observation?: SessionRunTerminalObservation,
): (row: GatewaySessionRow) => GatewaySessionRow {
  const keys = terminal.sessionKeys.map((key) => key.trim()).filter(Boolean);
  if (keys.length === 0) {
    return (row) => row;
  }
  const runId = terminal.runId?.trim() || null;
  // Match the Gateway's compact session error projection, redacting before truncation.
  const errorMessage = truncateUtf16Safe(
    formatUiExternalText(terminal.errorMessage).replace(/\s+/g, " ").trim(),
    160,
  );
  return (existing) => {
    if (!keys.some((key) => areUiSessionKeysEquivalent(existing.key, key))) {
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
    const lastRunError =
      terminal.status === "failed" || terminal.status === "timeout"
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
    if (
      (terminal.status !== "failed" && terminal.status !== "timeout") ||
      errorMessage ||
      replacementRunId
    ) {
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
  let changed = false;
  const sessions = result.sessions.map((existing) => {
    const next = reconcileRow(existing);
    changed ||= next !== existing;
    return next;
  });
  return changed ? { ...result, sessions } : result;
}
