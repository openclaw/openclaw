import fs from "node:fs";
import path from "node:path";
import { resolveEmbeddedSessionLane } from "../agents/pi-embedded-runner/lanes.js";
import {
  abortAndDrainEmbeddedPiRun,
  isEmbeddedPiRunActive,
  isEmbeddedPiRunHandleActive,
  resolveActiveEmbeddedRunSessionId,
  resolveActiveEmbeddedRunHandleSessionId,
} from "../agents/pi-embedded-runner/runs.js";
import { resolveStateDir } from "../config/paths.js";
import {
  type SessionEntry,
  loadSessionStore,
  updateSessionStore,
  resolveDefaultSessionStorePath,
} from "../config/sessions.js";
import { callGateway } from "../gateway/call.js";
import { getCommandLaneSnapshot, resetCommandLane } from "../process/command-queue.js";
import { enqueueCommandInLane } from "../process/command-queue.js";
import { diagnosticLogger as diag } from "./diagnostic-runtime.js";
import {
  formatStoppedCronSessionDiagnosticFields,
  resolveCronSessionDiagnosticContext,
} from "./diagnostic-session-context.js";
import {
  formatRecoveryOutcome,
  type StuckSessionRecoveryOutcome,
  type StuckSessionRecoveryRequest,
} from "./diagnostic-session-recovery.js";
import { isDiagnosticSessionStateCurrent } from "./diagnostic-session-state.js";

const STUCK_SESSION_ABORT_SETTLE_MS = 15_000;
const STALE_REPLY_TURN_MS = 2 * 60 * 1000;
const recoveriesInFlight = new Set<string>();

export type StuckSessionRecoveryParams = StuckSessionRecoveryRequest;

function recoveryKey(params: StuckSessionRecoveryParams): string | undefined {
  return params.sessionKey?.trim() || params.sessionId?.trim() || undefined;
}

function formatRecoveryContext(
  params: StuckSessionRecoveryParams,
  extra?: { activeSessionId?: string; lane?: string; activeCount?: number; queuedCount?: number },
): string {
  const fields = [
    `sessionId=${params.sessionId ?? extra?.activeSessionId ?? "unknown"}`,
    `sessionKey=${params.sessionKey ?? "unknown"}`,
    `age=${Math.round(params.ageMs / 1000)}s`,
    `queueDepth=${params.queueDepth ?? 0}`,
  ];
  if (extra?.activeSessionId) {
    fields.push(`activeSessionId=${extra.activeSessionId}`);
  }
  if (extra?.lane) {
    fields.push(`lane=${extra.lane}`);
  }
  if (extra?.activeCount !== undefined) {
    fields.push(`laneActive=${extra.activeCount}`);
  }
  if (extra?.queuedCount !== undefined) {
    fields.push(`laneQueued=${extra.queuedCount}`);
  }
  return fields.join(" ");
}

function resolveSessionStorePathsForRecovery(sessionKey?: string): string[] {
  const stateDir = resolveStateDir();
  const paths = new Set<string>();
  const agentId = sessionKey?.startsWith("agent:") ? sessionKey.split(":")[1]?.trim() : undefined;
  if (agentId) {
    paths.add(resolveDefaultSessionStorePath(agentId));
  }
  const agentsDir = path.join(stateDir, "agents");
  try {
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        paths.add(path.join(agentsDir, entry.name, "sessions.json"));
      }
    }
  } catch {
    // Best-effort only; explicit path recovery is still handled below.
  }
  return [...paths];
}

function findReplyTurnSessionEntry(params: {
  sessionKey?: string;
}): { storePath: string; entry: SessionEntry } | undefined {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return undefined;
  }
  for (const storePath of resolveSessionStorePathsForRecovery(sessionKey)) {
    try {
      const store = loadSessionStore(storePath);
      const entry = store[sessionKey];
      if (entry) {
        return { storePath, entry };
      }
    } catch {
      // Continue scanning other agent stores.
    }
  }
  return undefined;
}

function shouldCloseStaleReplyTurn(entry: SessionEntry, now = Date.now()): boolean {
  if (entry.replyTurnState !== "running") {
    return false;
  }
  const updatedAt = entry.replyTurnUpdatedAt ?? entry.replyTurnStartedAt ?? entry.updatedAt;
  return typeof updatedAt === "number" && now - updatedAt >= STALE_REPLY_TURN_MS;
}

async function sendRecoveryFallback(params: {
  sessionKey: string;
  entry: SessionEntry;
}): Promise<boolean> {
  const deliveryContext = params.entry.deliveryContext;
  const origin = params.entry.origin;
  const channel =
    deliveryContext?.channel ?? params.entry.channel ?? origin?.surface ?? origin?.provider;
  const to = deliveryContext?.to ?? params.entry.lastTo ?? origin?.to;
  if (!channel || !to) {
    return false;
  }
  try {
    await enqueueCommandInLane("message", () =>
      callGateway({
        method: "message.action",
        params: {
          action: "send",
          channel,
          target: to,
          accountId: deliveryContext?.accountId ?? params.entry.lastAccountId ?? origin?.accountId,
          threadId: deliveryContext?.threadId ?? params.entry.lastThreadId ?? origin?.threadId,
          message: "That run was interrupted before it could finish. Please send it again.",
        },
      }),
    );
    return true;
  } catch (err) {
    diag.warn(
      `stale reply turn recovery fallback failed: sessionKey=${params.sessionKey} err=${String(err)}`,
    );
    return false;
  }
}

async function closeStaleReplyTurnIfNeeded(params: { sessionKey?: string }): Promise<boolean> {
  const found = findReplyTurnSessionEntry({ sessionKey: params.sessionKey });
  if (!found || !params.sessionKey || !shouldCloseStaleReplyTurn(found.entry)) {
    return false;
  }
  const sent = await sendRecoveryFallback({ sessionKey: params.sessionKey, entry: found.entry });
  await updateSessionStore(found.storePath, async (store) => {
    const entry = store[params.sessionKey!];
    if (!entry || entry.replyTurnState !== "running") {
      return store;
    }
    store[params.sessionKey!] = {
      ...entry,
      replyTurnState: "failed",
      replyTurnUpdatedAt: Date.now(),
      replyTurnLastError: sent ? "recovered_after_restart" : "recovery_fallback_delivery_failed",
      updatedAt: Date.now(),
    };
    return store;
  });
  diag.warn(
    `stale reply turn recovery closed: sessionKey=${params.sessionKey} fallbackSent=${sent}`,
  );
  return true;
}

export async function recoverStuckDiagnosticSession(
  params: StuckSessionRecoveryParams,
): Promise<StuckSessionRecoveryOutcome> {
  const key = recoveryKey(params);
  if (!key || recoveriesInFlight.has(key)) {
    return {
      status: "skipped",
      action: "observe_only",
      reason: key ? "already_in_flight" : "missing_session_ref",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    };
  }

  recoveriesInFlight.add(key);
  try {
    if (
      !isDiagnosticSessionStateCurrent({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        generation: params.stateGeneration,
        state: "processing",
      })
    ) {
      return {
        status: "skipped",
        action: "observe_only",
        reason: "stale_session_state",
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
      };
    }
    const fallbackActiveSessionId =
      params.sessionId && isEmbeddedPiRunHandleActive(params.sessionId)
        ? params.sessionId
        : undefined;
    let activeSessionId = params.sessionKey
      ? (resolveActiveEmbeddedRunHandleSessionId(params.sessionKey) ?? fallbackActiveSessionId)
      : fallbackActiveSessionId;
    const activeWorkSessionId = params.sessionKey
      ? (resolveActiveEmbeddedRunSessionId(params.sessionKey) ?? params.sessionId)
      : params.sessionId;
    const laneKey = params.sessionKey?.trim() || params.sessionId?.trim();
    const sessionLane = laneKey ? resolveEmbeddedSessionLane(laneKey) : null;
    let aborted = false;
    let drained = true;
    let forceCleared = false;

    if (activeSessionId) {
      if (params.allowActiveAbort !== true) {
        const outcome: StuckSessionRecoveryOutcome = {
          status: "skipped",
          action: "observe_only",
          reason: "active_embedded_run",
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          activeSessionId,
          activeWorkKind: "embedded_run",
        };
        diag.warn(
          `stuck session recovery skipped: ${formatRecoveryContext(params, { activeSessionId })}`,
        );
        diag.warn(`stuck session recovery outcome: ${formatRecoveryOutcome(outcome)}`);
        return outcome;
      }
      const result = await abortAndDrainEmbeddedPiRun({
        sessionId: activeSessionId,
        sessionKey: params.sessionKey,
        settleMs: STUCK_SESSION_ABORT_SETTLE_MS,
        forceClear: true,
        reason: "stuck_recovery",
      });
      aborted = result.aborted;
      drained = result.drained;
      forceCleared = result.forceCleared;
    }

    if (!activeSessionId && activeWorkSessionId && isEmbeddedPiRunActive(activeWorkSessionId)) {
      if (params.allowActiveAbort === true) {
        const result = await abortAndDrainEmbeddedPiRun({
          sessionId: activeWorkSessionId,
          sessionKey: params.sessionKey,
          settleMs: STUCK_SESSION_ABORT_SETTLE_MS,
          forceClear: true,
          reason: "stuck_recovery_active_reply_work",
        });
        aborted = result.aborted;
        drained = result.drained;
        forceCleared = result.forceCleared;
        if (aborted) {
          activeSessionId = activeWorkSessionId;
        }
      } else {
        const outcome: StuckSessionRecoveryOutcome = {
          status: "skipped",
          action: "keep_lane",
          reason: "active_reply_work",
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          activeSessionId: activeWorkSessionId,
          activeWorkKind: "embedded_run",
        };
        diag.warn(`stuck session recovery outcome: ${formatRecoveryOutcome(outcome)}`);
        return outcome;
      }
    }

    const closedStaleReplyTurn = await closeStaleReplyTurnIfNeeded({
      sessionKey: params.sessionKey,
    });
    if (closedStaleReplyTurn) {
      const outcome: StuckSessionRecoveryOutcome = {
        status: "released",
        action: "release_lane",
        reason: "stale_reply_turn_closed",
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        released: 0,
        lane: sessionLane ?? undefined,
      };
      diag.warn(`stuck session recovery outcome: ${formatRecoveryOutcome(outcome)}`);
      return outcome;
    }

    if (!activeSessionId && sessionLane) {
      const laneSnapshot = getCommandLaneSnapshot(sessionLane);
      if (laneSnapshot.activeCount > 0) {
        const outcome: StuckSessionRecoveryOutcome = {
          status: "skipped",
          action: "keep_lane",
          reason: "active_lane_task",
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          lane: sessionLane,
          activeCount: laneSnapshot.activeCount,
          queuedCount: laneSnapshot.queuedCount,
        };
        diag.warn(`stuck session recovery outcome: ${formatRecoveryOutcome(outcome)}`);
        return outcome;
      }
    }

    const released =
      sessionLane && (!activeSessionId || !aborted || !drained) ? resetCommandLane(sessionLane) : 0;

    if (aborted || released > 0) {
      const action = aborted ? "abort_embedded_run" : "release_lane";
      const stoppedFields = formatStoppedCronSessionDiagnosticFields(
        resolveCronSessionDiagnosticContext({ sessionKey: params.sessionKey, activeSessionId }),
      );
      diag.warn(
        `stuck session recovery: sessionId=${params.sessionId ?? activeSessionId ?? "unknown"} sessionKey=${
          params.sessionKey ?? "unknown"
        } age=${Math.round(params.ageMs / 1000)}s action=${action} aborted=${aborted} drained=${drained} released=${released}${
          stoppedFields ? ` ${stoppedFields}` : ""
        }`,
      );
      const outcome: StuckSessionRecoveryOutcome = aborted
        ? {
            status: "aborted",
            action: "abort_embedded_run",
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            activeSessionId,
            activeWorkKind: "embedded_run",
            aborted,
            drained,
            forceCleared,
            released,
            lane: sessionLane ?? undefined,
          }
        : {
            status: "released",
            action: "release_lane",
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            released,
            lane: sessionLane ?? undefined,
          };
      diag.warn(`stuck session recovery outcome: ${formatRecoveryOutcome(outcome)}`);
      return outcome;
    }
    const outcome: StuckSessionRecoveryOutcome = {
      status: "noop",
      action: "none",
      reason: "no_active_work",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      lane: sessionLane ?? undefined,
    };
    diag.warn(`stuck session recovery outcome: ${formatRecoveryOutcome(outcome)}`);
    return outcome;
  } catch (err) {
    const outcome: StuckSessionRecoveryOutcome = {
      status: "failed",
      action: "none",
      reason: "exception",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      error: String(err),
    };
    diag.warn(
      `stuck session recovery failed: sessionId=${params.sessionId ?? "unknown"} sessionKey=${
        params.sessionKey ?? "unknown"
      } err=${String(err)}`,
    );
    return outcome;
  } finally {
    recoveriesInFlight.delete(key);
  }
}

export const __testing = {
  resetRecoveriesInFlight(): void {
    recoveriesInFlight.clear();
  },
};
