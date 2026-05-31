import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { loadGatewaySessionRow } from "../session-utils.js";
import type { GatewayRequestContext } from "./types.js";

type TrackedActiveSessionRun = {
  runId: string;
  sessionKey: string;
  agentId?: string;
};

function collectTrackedActiveSessionRuns(
  context: Partial<Pick<GatewayRequestContext, "chatAbortControllers">>,
  options?: { excludeRunIds?: ReadonlySet<string> },
): TrackedActiveSessionRun[] {
  const runs: TrackedActiveSessionRun[] = [];
  if (!(context.chatAbortControllers instanceof Map)) {
    return runs;
  }
  for (const [runId, active] of context.chatAbortControllers) {
    if (options?.excludeRunIds?.has(runId)) {
      continue;
    }
    if (
      active.projectSessionActive !== false &&
      typeof active.sessionKey === "string" &&
      active.sessionKey.trim()
    ) {
      runs.push({
        runId,
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
  if (key !== "global" || agentId === undefined) {
    return true;
  }
  const activeAgentId = active.agentId ?? defaultAgentId;
  return activeAgentId ? normalizeAgentId(activeAgentId) === normalizeAgentId(agentId) : false;
}

function hasTrackedActiveSessionRun(params: {
  context: Partial<Pick<GatewayRequestContext, "chatAbortControllers">>;
  requestedKey: string;
  canonicalKey: string;
  agentId?: string;
  defaultAgentId?: string;
  excludeRunIds?: ReadonlySet<string>;
}): boolean {
  const activeRuns = collectTrackedActiveSessionRuns(params.context, {
    excludeRunIds: params.excludeRunIds,
  });
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

export function emitSessionsChanged(
  context: Pick<
    GatewayRequestContext,
    | "broadcastToConnIds"
    | "chatAbortControllers"
    | "getRuntimeConfig"
    | "getSessionEventSubscriberConnIds"
  >,
  payload: {
    sessionKey?: string;
    agentId?: string;
    reason: string;
    compacted?: boolean;
    hasActiveRun?: boolean;
    excludeActiveRunIds?: readonly string[];
  },
) {
  const connIds = context.getSessionEventSubscriberConnIds();
  if (connIds.size === 0) {
    return;
  }
  const sessionRow = payload.sessionKey
    ? loadGatewaySessionRow(
        payload.sessionKey,
        payload.sessionKey === "global" && payload.agentId
          ? { agentId: payload.agentId }
          : undefined,
      )
    : null;
  const omitUnscopedGlobalGoal = payload.sessionKey === "global" && !payload.agentId;
  const defaultAgentId = resolveDefaultAgentId(context.getRuntimeConfig());
  const { excludeActiveRunIds, ...eventPayload } = payload;
  const excludeRunIds = new Set(excludeActiveRunIds ?? []);
  context.broadcastToConnIds(
    "sessions.changed",
    {
      ...eventPayload,
      ts: Date.now(),
      ...(sessionRow
        ? {
            updatedAt: sessionRow.updatedAt ?? undefined,
            sessionId: sessionRow.sessionId,
            kind: sessionRow.kind,
            channel: sessionRow.channel,
            subject: sessionRow.subject,
            groupChannel: sessionRow.groupChannel,
            space: sessionRow.space,
            chatType: sessionRow.chatType,
            origin: sessionRow.origin,
            spawnedBy: sessionRow.spawnedBy,
            spawnedWorkspaceDir: sessionRow.spawnedWorkspaceDir,
            spawnedCwd: sessionRow.spawnedCwd,
            forkedFromParent: sessionRow.forkedFromParent,
            spawnDepth: sessionRow.spawnDepth,
            subagentRole: sessionRow.subagentRole,
            subagentControlScope: sessionRow.subagentControlScope,
            label: sessionRow.label,
            displayName: sessionRow.displayName,
            deliveryContext: sessionRow.deliveryContext,
            parentSessionKey: sessionRow.parentSessionKey,
            childSessions: sessionRow.childSessions,
            thinkingLevel: sessionRow.thinkingLevel,
            fastMode: sessionRow.fastMode,
            verboseLevel: sessionRow.verboseLevel,
            traceLevel: sessionRow.traceLevel,
            reasoningLevel: sessionRow.reasoningLevel,
            elevatedLevel: sessionRow.elevatedLevel,
            sendPolicy: sessionRow.sendPolicy,
            systemSent: sessionRow.systemSent,
            abortedLastRun: sessionRow.abortedLastRun,
            inputTokens: sessionRow.inputTokens,
            outputTokens: sessionRow.outputTokens,
            lastChannel: sessionRow.lastChannel,
            lastTo: sessionRow.lastTo,
            lastAccountId: sessionRow.lastAccountId,
            lastThreadId: sessionRow.lastThreadId,
            totalTokens: sessionRow.totalTokens,
            totalTokensFresh: sessionRow.totalTokensFresh,
            ...(omitUnscopedGlobalGoal ? {} : { goal: sessionRow.goal ?? null }),
            contextTokens: sessionRow.contextTokens,
            estimatedCostUsd: sessionRow.estimatedCostUsd,
            responseUsage: sessionRow.responseUsage,
            modelProvider: sessionRow.modelProvider,
            model: sessionRow.model,
            status: sessionRow.status,
            hasActiveRun:
              payload.hasActiveRun ??
              hasTrackedActiveSessionRun({
                context,
                requestedKey: payload.sessionKey ?? sessionRow.key,
                canonicalKey: sessionRow.key,
                agentId: sessionRow.key === "global" ? payload.agentId : undefined,
                defaultAgentId,
                excludeRunIds,
              }),
            startedAt: sessionRow.startedAt,
            endedAt: sessionRow.endedAt,
            runtimeMs: sessionRow.runtimeMs,
            compactionCheckpointCount: sessionRow.compactionCheckpointCount,
            latestCompactionCheckpoint: sessionRow.latestCompactionCheckpoint,
            pluginExtensions: sessionRow.pluginExtensions,
          }
        : {}),
    },
    connIds,
    { dropIfSlow: true },
  );
}
