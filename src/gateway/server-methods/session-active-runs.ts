import { isEmbeddedAgentRunActive } from "../../agents/embedded-agent-runner/runs.js";
import { hasProjectedAgentRunForSession } from "../../infra/agent-events.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { GatewayRequestContext } from "./types.js";

/** Active-run matcher for Control UI-visible controllers. */
export type TrackedActiveSessionRun = {
  runId: string;
  sessionKey?: string;
  sessionId?: string;
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
  for (const [runId, active] of context.chatAbortControllers) {
    if (active.projectSessionActive !== false && active.controlUiVisible !== false) {
      const sessionKey = active.sessionKey?.trim();
      const sessionId = active.sessionId?.trim();
      if (!sessionKey && !sessionId) {
        continue;
      }
      runs.push({
        runId,
        ...(sessionKey ? { sessionKey } : {}),
        ...(sessionId ? { sessionId } : {}),
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
  sessionId?: string;
  agentId?: string;
  defaultAgentId?: string;
  scopeUnknownByAgent?: boolean;
  now?: number;
}): TrackedActiveSessionRunSnapshot {
  const runs: TrackedActiveSessionRunSnapshot["runs"] = [];
  if (!(params.context.chatAbortControllers instanceof Map)) {
    return { hasActiveRun: false, runs };
  }
  const now = params.now ?? Date.now();
  const targetSessionId = params.sessionId?.trim() || undefined;
  for (const [runId, active] of params.context.chatAbortControllers.entries()) {
    const sessionKey = active.sessionKey?.trim();
    const sessionId = active.sessionId?.trim();
    if (
      active.projectSessionActive === false ||
      active.controlUiVisible === false ||
      (!sessionKey && !sessionId)
    ) {
      continue;
    }
    const projected: TrackedActiveSessionRun = {
      runId,
      ...(sessionKey ? { sessionKey } : {}),
      ...(sessionId ? { sessionId } : {}),
      agentId: typeof active.agentId === "string" ? normalizeAgentId(active.agentId) : undefined,
    };
    const matches = isTrackedActiveSessionRunForTarget(projected, {
      requestedKey: params.requestedKey,
      canonicalKey: params.canonicalKey,
      ...(targetSessionId ? { sessionId: targetSessionId } : {}),
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.defaultAgentId ? { defaultAgentId: params.defaultAgentId } : {}),
      ...(params.scopeUnknownByAgent !== undefined
        ? { scopeUnknownByAgent: params.scopeUnknownByAgent }
        : {}),
    });
    if (!matches) {
      continue;
    }
    const visibleSessionId = sessionId ?? targetSessionId;
    if (!visibleSessionId) {
      continue;
    }
    runs.push({
      runId,
      sessionId: visibleSessionId,
      sessionKey: sessionKey ?? params.canonicalKey,
      ...(projected.agentId ? { agentId: projected.agentId } : {}),
      ...(active.ownerConnId ? { ownerConnId: active.ownerConnId } : {}),
      ...(active.kind ? { kind: active.kind } : {}),
      ...(typeof active.startedAtMs === "number"
        ? {
            startedAtMs: active.startedAtMs,
            startedAgeMs: Math.max(0, now - active.startedAtMs),
          }
        : {}),
      ...(typeof active.expiresAtMs === "number"
        ? {
            expiresAtMs: active.expiresAtMs,
            expiresInMs: Math.max(0, active.expiresAtMs - now),
          }
        : {}),
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
  options?: { scopeUnknownByAgent?: boolean },
): boolean {
  if (!active.sessionKey || active.sessionKey !== key) {
    return false;
  }
  const shouldScopeByAgent =
    key === "global" || (key === "unknown" && options?.scopeUnknownByAgent === true);
  if (!shouldScopeByAgent) {
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

export function isTrackedActiveSessionRunForTarget(
  active: TrackedActiveSessionRun,
  params: {
    requestedKey: string;
    canonicalKey: string;
    sessionId?: string;
    agentId?: string;
    defaultAgentId?: string;
    scopeUnknownByAgent?: boolean;
  },
): boolean {
  const matchesCanonicalKey = isTrackedActiveSessionRunForKey(
    active,
    params.canonicalKey,
    params.agentId,
    params.defaultAgentId,
    { scopeUnknownByAgent: params.scopeUnknownByAgent },
  );
  const matchesRequestedKey =
    params.requestedKey === params.canonicalKey
      ? matchesCanonicalKey
      : isTrackedActiveSessionRunForKey(
          active,
          params.requestedKey,
          params.agentId,
          params.defaultAgentId,
          { scopeUnknownByAgent: params.scopeUnknownByAgent },
        );
  const targetSessionId = params.sessionId?.trim() || undefined;
  // Session-id-only controllers predate keyed run state; keyed controllers must
  // still match the diagnosed key so a reused id cannot borrow another session's run.
  const matchesSessionId =
    targetSessionId !== undefined &&
    active.sessionId === targetSessionId &&
    (!active.sessionKey || matchesCanonicalKey || matchesRequestedKey);
  return matchesCanonicalKey || matchesRequestedKey || matchesSessionId;
}

/** Returns true when either requested or canonical session key has a visible active run. */
export function hasTrackedActiveSessionRun(params: {
  context: Partial<Pick<GatewayRequestContext, "chatAbortControllers">>;
  requestedKey: string;
  canonicalKey: string;
  agentId?: string;
  defaultAgentId?: string;
  scopeUnknownByAgent?: boolean;
}): boolean {
  const activeRuns = collectTrackedActiveSessionRuns(params.context);
  return activeRuns.some(
    (active) =>
      isTrackedActiveSessionRunForKey(
        active,
        params.canonicalKey,
        params.agentId,
        params.defaultAgentId,
        { scopeUnknownByAgent: params.scopeUnknownByAgent },
      ) ||
      isTrackedActiveSessionRunForKey(
        active,
        params.requestedKey,
        params.agentId,
        params.defaultAgentId,
        { scopeUnknownByAgent: params.scopeUnknownByAgent },
      ),
  );
}

export function resolveVisibleActiveSessionRunState(params: {
  context: Partial<Pick<GatewayRequestContext, "chatAbortControllers">>;
  requestedKey: string;
  canonicalKey: string;
  sessionId?: string;
  agentId?: string;
  defaultAgentId?: string;
  scopeUnknownByAgent?: boolean;
}): { active: boolean; runIds: string[] } {
  const sessionId = params.sessionId?.trim();
  const runIds = collectTrackedActiveSessionRuns(params.context)
    .filter((active) =>
      isTrackedActiveSessionRunForTarget(active, {
        requestedKey: params.requestedKey,
        canonicalKey: params.canonicalKey,
        ...(sessionId ? { sessionId } : {}),
        ...(params.agentId ? { agentId: params.agentId } : {}),
        ...(params.defaultAgentId ? { defaultAgentId: params.defaultAgentId } : {}),
        ...(params.scopeUnknownByAgent !== undefined
          ? { scopeUnknownByAgent: params.scopeUnknownByAgent }
          : {}),
      }),
    )
    .map((active) => active.runId)
    .toSorted();
  const hasProjectedRun = hasProjectedAgentRunForSession({
    sessionKeys: [params.requestedKey, params.canonicalKey],
    ...(sessionId ? { sessionId } : {}),
  });
  return {
    active:
      runIds.length > 0 ||
      hasProjectedRun ||
      (sessionId !== undefined && isEmbeddedAgentRunActive(sessionId)),
    runIds,
  };
}

export function hasVisibleActiveSessionRun(params: {
  context: Partial<Pick<GatewayRequestContext, "chatAbortControllers">>;
  requestedKey: string;
  canonicalKey: string;
  sessionId?: string;
  agentId?: string;
  defaultAgentId?: string;
  scopeUnknownByAgent?: boolean;
}): boolean {
  return resolveVisibleActiveSessionRunState(params).active;
}
