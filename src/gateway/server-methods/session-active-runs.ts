// Session active-run helpers decide whether session operations should treat a
// session as busy based on Control UI-visible active chat/agent runs.
import { isAcpSessionKey, normalizeAgentId } from "../../routing/session-key.js";
import type { GatewaySessionRow, SessionRunStatus } from "../session-utils.types.js";
import type { GatewayRequestContext } from "./types.js";

/**
 * Grace window for the stale-row projection. A row that still claims `running`
 * but has not been touched within this window — and has no live run evidence
 * in this gateway process — is surfaced as `stale` to sessions.list callers.
 * Sized generously so brief lulls between turns never flip a healthy run.
 */
export const STALE_SESSION_ROW_GRACE_MS = 5 * 60 * 1_000;

type SessionRowRunProjectionInput = Pick<
  GatewaySessionRow,
  "key" | "sessionId" | "status" | "updatedAt" | "subagentRunState" | "hasActiveSubagentRun"
>;

/**
 * Projects the display run status for a sessions.list row.
 *
 * Persisted terminal statuses pass through unchanged. A `running` row is kept
 * `running` while any live-run signal is present (a Control UI-visible run, an
 * in-process embedded run for its sessionId/key, a live subagent registry run,
 * an ACP session whose run can live out of process, or a fresh `updatedAt`
 * inside the grace window). Otherwise the row is reported as `stale`: it claims
 * to be running but this gateway sees no evidence that it actually is, which is
 * the signature of a run orphaned by a crash or restart.
 */
export function projectSessionRowRunStatus(params: {
  row: SessionRowRunProjectionInput;
  hasActiveRun: boolean;
  activeEmbeddedRunSessionIds: ReadonlySet<string>;
  activeEmbeddedRunSessionKeys: ReadonlySet<string>;
  now: number;
}): SessionRunStatus | undefined {
  const { row } = params;
  if (row.status !== "running") {
    return row.status;
  }
  if (params.hasActiveRun) {
    return "running";
  }
  if (typeof row.sessionId === "string" && params.activeEmbeddedRunSessionIds.has(row.sessionId)) {
    return "running";
  }
  if (params.activeEmbeddedRunSessionKeys.has(row.key)) {
    return "running";
  }
  if (row.subagentRunState === "active" || row.hasActiveSubagentRun === true) {
    return "running";
  }
  // ACP runs are driven by an external client and need not appear in this
  // gateway's tracked-run or embedded-run state, so never call them stale.
  if (isAcpSessionKey(row.key)) {
    return "running";
  }
  const updatedAt =
    typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt) ? row.updatedAt : undefined;
  if (updatedAt === undefined || params.now - updatedAt <= STALE_SESSION_ROW_GRACE_MS) {
    return "running";
  }
  return "stale";
}

/**
 * Active-run matcher used by session list/update methods.
 *
 * It only reports runs visible to the Control UI so background or hidden runs
 * do not make a session look busy to user-facing session operations.
 */
type TrackedActiveSessionRun = {
  sessionKey: string;
  agentId?: string;
};

function collectTrackedActiveSessionRuns(
  context: Partial<Pick<GatewayRequestContext, "chatAbortControllers">>,
): TrackedActiveSessionRun[] {
  const runs: TrackedActiveSessionRun[] = [];
  if (!(context.chatAbortControllers instanceof Map)) {
    return runs;
  }
  for (const active of context.chatAbortControllers.values()) {
    if (
      active.projectSessionActive !== false &&
      active.controlUiVisible !== false &&
      typeof active.sessionKey === "string" &&
      active.sessionKey.trim()
    ) {
      runs.push({
        sessionKey: active.sessionKey,
        agentId: typeof active.agentId === "string" ? normalizeAgentId(active.agentId) : undefined,
      });
    }
  }
  return runs;
}

function isTrackedActiveSessionRunForKey(
  active: TrackedActiveSessionRun,
  key: string,
  agentId?: string,
  defaultAgentId?: string,
): boolean {
  if (active.sessionKey !== key) {
    return false;
  }
  if (key !== "global") {
    return true;
  }
  const requestedAgentId = agentId ?? defaultAgentId;
  if (!requestedAgentId) {
    return true;
  }
  const activeAgentId = active.agentId ?? defaultAgentId;
  return activeAgentId
    ? normalizeAgentId(activeAgentId) === normalizeAgentId(requestedAgentId)
    : false;
}

/** Returns true when either requested or canonical session key has a visible active run. */
export function hasTrackedActiveSessionRun(params: {
  context: Partial<Pick<GatewayRequestContext, "chatAbortControllers">>;
  requestedKey: string;
  canonicalKey: string;
  agentId?: string;
  defaultAgentId?: string;
}): boolean {
  const activeRuns = collectTrackedActiveSessionRuns(params.context);
  return activeRuns.some(
    (active) =>
      isTrackedActiveSessionRunForKey(
        active,
        params.canonicalKey,
        params.agentId,
        params.defaultAgentId,
      ) ||
      isTrackedActiveSessionRunForKey(
        active,
        params.requestedKey,
        params.agentId,
        params.defaultAgentId,
      ),
  );
}
