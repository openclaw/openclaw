import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import type {
  AgentRunContext,
  AgentRunModel,
  ProjectedAgentRunIndex,
  ProjectedAgentRunState,
} from "./agent-run-registry.types.js";

export function projectedRunIdentity(agentId: string, value: string): string {
  return `${normalizeAgentId(agentId)}\0${value}`;
}

export function projectedModelIdentity(
  agentId: string,
  sessionId: string,
  sessionKey: string,
): string {
  return JSON.stringify([normalizeAgentId(agentId), sessionId, sessionKey]);
}

export function deriveProjectedAgentRunIndex(
  contexts: Iterable<AgentRunContext>,
  lifecycleGeneration: string,
): ProjectedAgentRunIndex {
  const modelsBySession = new Map<string, AgentRunModel | null>();
  const pendingModelSessions = new Set<string>();
  const sessionKeys = new Map<string, ProjectedAgentRunState>();
  const sessionIds = new Map<string, ProjectedAgentRunState>();
  const ownerlessSessionKeys = new Map<string, ProjectedAgentRunState>();
  const ownerlessSessionIds = new Map<string, ProjectedAgentRunState>();
  const add = (
    index: Map<string, ProjectedAgentRunState>,
    key: string,
    status: ProjectedAgentRunState,
  ) => {
    const previous = index.get(key);
    if (previous !== "running" && !(previous === "queued" && status === "capacity-wait")) {
      index.set(key, status);
    }
  };
  for (const context of contexts) {
    const queued = (context.capacityWaits?.size ?? 0) > 0;
    const agentId = context.agentId ?? parseAgentSessionKey(context.sessionKey)?.agentId;
    if (
      context.lifecycleGeneration === lifecycleGeneration &&
      agentId &&
      context.sessionId &&
      context.sessionKey &&
      context.projectSessionActive !== false &&
      context.projectSessionLifecycle !== false &&
      context.isControlUiVisible !== false
    ) {
      const key = projectedModelIdentity(agentId, context.sessionId, context.sessionKey);
      pendingModelSessions.add(key);
      if (!queued && (context.activeModel !== undefined || context.projectSessionActive === true)) {
        const model = context.activeModel ?? null;
        const previous = modelsBySession.get(key);
        modelsBySession.set(
          key,
          previous === undefined ||
            (previous?.provider === model?.provider && previous?.model === model?.model)
            ? model
            : null,
        );
      }
    }
    if (
      context.lifecycleGeneration !== lifecycleGeneration ||
      (context.projectSessionActive !== true &&
        (!queued ||
          context.projectSessionActive === false ||
          context.projectSessionLifecycle === false))
    ) {
      continue;
    }
    const status = !queued
      ? "running"
      : context.projectSessionActive === true
        ? "queued"
        : "capacity-wait";
    if (context.sessionKey !== undefined && agentId) {
      add(sessionKeys, projectedRunIdentity(agentId, context.sessionKey), status);
    } else if (context.sessionKey !== undefined) {
      add(ownerlessSessionKeys, context.sessionKey, status);
    }
    if (context.sessionId !== undefined && agentId) {
      add(sessionIds, projectedRunIdentity(agentId, context.sessionId), status);
    } else if (context.sessionId !== undefined) {
      add(ownerlessSessionIds, context.sessionId, status);
    }
  }
  // Admission and queue waits have no candidate yet; they must not hide an executing sibling.
  for (const key of pendingModelSessions) {
    if (!modelsBySession.has(key)) {
      modelsBySession.set(key, null);
    }
  }
  return { modelsBySession, sessionKeys, sessionIds, ownerlessSessionKeys, ownerlessSessionIds };
}
