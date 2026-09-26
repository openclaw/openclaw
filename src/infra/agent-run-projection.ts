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

/** Activity selected by a session key must belong to the agent encoded in that key. */
export function* iterateProjectedAgentRunSessionKeys(index: ProjectedAgentRunIndex) {
  for (const identity of index.sessionKeys.keys()) {
    const key = identity.slice(identity.indexOf("\0") + 1);
    const agentId = parseAgentSessionKey(key)?.agentId;
    if (agentId && identity === projectedRunIdentity(agentId, key)) {
      yield key;
    }
  }
}

export function areAgentRunModelsEqual(
  left: AgentRunModel | null | undefined,
  right: AgentRunModel | null | undefined,
): boolean {
  return left?.provider === right?.provider && left?.model === right?.model;
}

/** Admission waits cannot hide an independently running or queued producer. */
export function mergeProjectedAgentRunStates(
  previous: ProjectedAgentRunState | undefined,
  next: ProjectedAgentRunState | undefined,
): ProjectedAgentRunState | undefined {
  return previous === "running" ||
    next === undefined ||
    (previous === "queued" && next !== "running")
    ? previous
    : next;
}

export function resolveAgentRunProjectionProgressState(
  params: {
    sessionKeys: readonly string[];
    sessionId?: string;
    agentId?: string;
    defaultAgentId?: string;
  },
  index: ProjectedAgentRunIndex,
): ProjectedAgentRunState | undefined {
  let agentId = params.agentId;
  if (agentId === undefined) {
    for (const key of params.sessionKeys) {
      agentId = parseAgentSessionKey(key)?.agentId;
      if (agentId !== undefined) {
        break;
      }
    }
    agentId ??= params.defaultAgentId;
  }
  if (!agentId) {
    return undefined;
  }
  const agentPrefix = projectedRunIdentity(agentId, "");
  const mayAdoptOwnerless =
    params.defaultAgentId !== undefined &&
    agentPrefix === projectedRunIdentity(params.defaultAgentId, "");
  let status: ProjectedAgentRunState | undefined;
  for (const sessionKey of params.sessionKeys) {
    status = mergeProjectedAgentRunStates(status, index.sessionKeys.get(agentPrefix + sessionKey));
    if (status === "running") {
      return status;
    }
    if (mayAdoptOwnerless) {
      status = mergeProjectedAgentRunStates(status, index.ownerlessSessionKeys.get(sessionKey));
      if (status === "running") {
        return status;
      }
    }
  }
  if (params.sessionId !== undefined) {
    status = mergeProjectedAgentRunStates(
      status,
      index.sessionIds.get(agentPrefix + params.sessionId),
    );
    if (mayAdoptOwnerless) {
      status = mergeProjectedAgentRunStates(
        status,
        index.ownerlessSessionIds.get(params.sessionId),
      );
    }
  }
  return status;
}

/** Canonicalizes every run-context field consumed by the session projection. */
export function projectedAgentRunInputKey(context: Readonly<AgentRunContext>): string {
  const agentId = context.agentId ?? parseAgentSessionKey(context.sessionKey)?.agentId;
  return JSON.stringify([
    context.lifecycleGeneration ?? null,
    agentId ? normalizeAgentId(agentId) : null,
    context.sessionId ?? null,
    context.sessionKey ?? null,
    context.projectSessionActive ?? null,
    context.projectSessionLifecycle ?? null,
    context.isControlUiVisible ?? null,
    (context.capacityWaits?.size ?? 0) > 0,
    context.activeModel?.provider ?? null,
    context.activeModel?.model ?? null,
  ]);
}

export function buildAgentRunProjectionIndex(params: {
  contexts: Iterable<Readonly<AgentRunContext>>;
  lifecycleGeneration: string;
}): ProjectedAgentRunIndex {
  const modelsBySessionId = new Map<string, AgentRunModel | null>();
  const pendingModelSessionIds = new Set<string>();
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
    if (previous !== status && mergeProjectedAgentRunStates(previous, status) === status) {
      index.set(key, status);
    }
  };
  for (const context of params.contexts) {
    const queued = (context.capacityWaits?.size ?? 0) > 0;
    const agentId = context.agentId ?? parseAgentSessionKey(context.sessionKey)?.agentId;
    if (
      context.lifecycleGeneration === params.lifecycleGeneration &&
      agentId &&
      context.sessionId &&
      context.sessionKey &&
      context.projectSessionActive !== false &&
      context.projectSessionLifecycle !== false &&
      context.isControlUiVisible !== false
    ) {
      const key = projectedRunIdentity(agentId, context.sessionId);
      pendingModelSessionIds.add(key);
      if (!queued && (context.activeModel !== undefined || context.projectSessionActive === true)) {
        const model = context.activeModel ?? null;
        const previous = modelsBySessionId.get(key);
        modelsBySessionId.set(
          key,
          previous === undefined || areAgentRunModelsEqual(previous, model) ? model : null,
        );
      }
    }
    if (
      context.lifecycleGeneration !== params.lifecycleGeneration ||
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
  for (const key of pendingModelSessionIds) {
    if (!modelsBySessionId.has(key)) {
      modelsBySessionId.set(key, null);
    }
  }
  return { modelsBySessionId, sessionKeys, sessionIds, ownerlessSessionKeys, ownerlessSessionIds };
}
