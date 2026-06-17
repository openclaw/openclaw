// Session active-run helpers decide whether session operations should treat a
// session as busy based on Control UI-visible active chat/agent runs.
import { normalizeAgentId } from "../../routing/session-key.js";
import type { GatewayRequestContext } from "./types.js";

/**
 * Active-run matcher used by session list/update methods.
 *
 * It only reports runs visible to the Control UI so background or hidden runs
 * do not make a session look busy to user-facing session operations.
 */
export type TrackedActiveSessionRun = {
  sessionKey: string;
  agentId?: string;
};

export type TrackedActiveSessionRunSnapshot = {
  hasActiveRun: boolean;
  runs: Array<{
    runId: string;
    sessionId: string;
    sessionKey: string;
    agentId?: string;
    ownerConnId?: string;
    kind?: "chat-send" | "agent";
    startedAtMs?: number;
    expiresAtMs?: number;
    startedAgeMs?: number;
    expiresInMs?: number;
    terminalPending?: boolean;
    terminalPersisted?: boolean;
  }>;
};

export function collectTrackedActiveSessionRuns(
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

export function collectTrackedActiveSessionRunSnapshot(params: {
  context: Partial<Pick<GatewayRequestContext, "chatAbortControllers">>;
  requestedKey: string;
  canonicalKey: string;
  agentId?: string;
  defaultAgentId?: string;
  now?: number;
}): TrackedActiveSessionRunSnapshot {
  const runs: TrackedActiveSessionRunSnapshot["runs"] = [];
  if (!(params.context.chatAbortControllers instanceof Map)) {
    return { hasActiveRun: false, runs };
  }
  const now = params.now ?? Date.now();
  for (const [runId, active] of params.context.chatAbortControllers.entries()) {
    const projected = {
      sessionKey: active.sessionKey,
      agentId: typeof active.agentId === "string" ? normalizeAgentId(active.agentId) : undefined,
    };
    const isVisible =
      active.projectSessionActive !== false &&
      active.controlUiVisible !== false &&
      typeof active.sessionKey === "string" &&
      active.sessionKey.trim();
    const matches =
      isVisible &&
      (isTrackedActiveSessionRunForKey(
        projected,
        params.canonicalKey,
        params.agentId,
        params.defaultAgentId,
      ) ||
        isTrackedActiveSessionRunForKey(
          projected,
          params.requestedKey,
          params.agentId,
          params.defaultAgentId,
        ));
    if (!matches) {
      continue;
    }
    runs.push({
      runId,
      sessionId: active.sessionId,
      sessionKey: active.sessionKey,
      ...(projected.agentId ? { agentId: projected.agentId } : {}),
      ...(active.ownerConnId ? { ownerConnId: active.ownerConnId } : {}),
      ...(active.kind ? { kind: active.kind } : {}),
      startedAtMs: active.startedAtMs,
      expiresAtMs: active.expiresAtMs,
      startedAgeMs: Math.max(0, now - active.startedAtMs),
      expiresInMs: Math.max(0, active.expiresAtMs - now),
      ...(active.projectSessionTerminalPending !== undefined
        ? { terminalPending: active.projectSessionTerminalPending }
        : {}),
      ...(active.projectSessionTerminalPersisted !== undefined
        ? { terminalPersisted: active.projectSessionTerminalPersisted }
        : {}),
    });
  }
  return {
    hasActiveRun: runs.length > 0,
    runs: runs.toSorted((a, b) => a.runId.localeCompare(b.runId)),
  };
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
