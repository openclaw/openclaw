import type { AgentEventPayload } from "../infra/agent-events.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { listTasksForRelatedSessionKey } from "../tasks/task-registry.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";

export type SessionToolActivity = {
  id: string;
  sessionKey: string;
  runId: string;
  toolCallId: string;
  name: string;
  title: string;
  status: "running";
  startedAt: number;
  updatedAt: number;
};

type SessionActivityState = {
  toolsById: Map<string, SessionToolActivity>;
  revisionsBySessionKey: Map<string, number>;
};

const SESSION_ACTIVITY_STATE_KEY = Symbol.for("openclaw.gateway.sessionActivity");

function getSessionActivityState(): SessionActivityState {
  return resolveGlobalSingleton<SessionActivityState>(SESSION_ACTIVITY_STATE_KEY, () => ({
    toolsById: new Map(),
    revisionsBySessionKey: new Map(),
  }));
}

const MAX_SESSION_ACTIVITY_DESCENDANTS = 128;

export type SessionActivityMutation = {
  sessionKey: string;
  revision: number;
  sourceSessionKey?: string;
};

export type SessionActivitySnapshot = {
  key: string;
  revision: number;
  includedSessionKeys: string[];
  truncated: boolean;
  tasks: TaskRecord[];
  tools: SessionToolActivity[];
};

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function compareTaskActivityNewestFirst(left: TaskRecord, right: TaskRecord): number {
  const leftAt = left.lastEventAt ?? left.startedAt ?? left.createdAt;
  const rightAt = right.lastEventAt ?? right.startedAt ?? right.createdAt;
  return rightAt - leftAt || left.taskId.localeCompare(right.taskId);
}

function toPluginToolActivity(activity: SessionToolActivity) {
  return {
    id: activity.id,
    name: activity.name,
    title: activity.title,
    startedAt: activity.startedAt,
    updatedAt: activity.updatedAt,
  };
}

function emitPluginToolActivity(params: {
  activity: SessionToolActivity;
  phase: "started" | "updated" | "finished";
}) {
  const runner = getGlobalHookRunner();
  if (!runner) {
    return;
  }
  const event = {
    phase: params.phase,
    activity: toPluginToolActivity(params.activity),
  };
  const context = {
    sessionKey: params.activity.sessionKey,
    runId: params.activity.runId,
    toolCallId: params.activity.toolCallId,
  };
  if (params.phase === "started" && runner.hasHooks("tool_started")) {
    void runner.runToolStarted(event, context).catch(() => {});
  } else if (params.phase === "updated" && runner.hasHooks("tool_updated")) {
    void runner.runToolUpdated(event, context).catch(() => {});
  } else if (params.phase === "finished" && runner.hasHooks("tool_finished")) {
    void runner.runToolFinished(event, context).catch(() => {});
  }
}

/** Advance a best-effort per-session activity version after a visible mutation. */
export function bumpSessionActivityRevision(sessionKey: string): number | undefined {
  const normalizedSessionKey = sessionKey.trim();
  if (!normalizedSessionKey) {
    return undefined;
  }
  const state = getSessionActivityState();
  const next = (state.revisionsBySessionKey.get(normalizedSessionKey) ?? 0) + 1;
  state.revisionsBySessionKey.set(normalizedSessionKey, next);
  return next;
}

export function getSessionActivityRevision(sessionKey: string): number {
  const normalizedSessionKey = sessionKey.trim();
  return normalizedSessionKey
    ? (getSessionActivityState().revisionsBySessionKey.get(normalizedSessionKey) ?? 0)
    : 0;
}

/**
 * Return every session key whose activity view includes this task. This walks
 * parent task links backwards so a root session is invalidated for a nested
 * child task update.
 */
export function listRelatedSessionActivityKeys(task: TaskRecord): string[] {
  return listSessionActivityAncestorKeys([
    task.ownerKey,
    task.requesterSessionKey,
    task.childSessionKey,
  ]);
}

/** Return a session and every ancestor session that includes it as a descendant. */
export function listSessionActivityAncestorKeys(sessionKeys: Array<string | undefined>): string[] {
  const keys = new Set<string>();
  const pending = sessionKeys
    .map(readNonEmptyString)
    .filter((value): value is string => Boolean(value));

  while (pending.length > 0 && keys.size < MAX_SESSION_ACTIVITY_DESCENDANTS) {
    const sessionKey = pending.shift();
    if (!sessionKey || keys.has(sessionKey)) {
      continue;
    }
    keys.add(sessionKey);
    for (const candidate of listTasksForRelatedSessionKey(sessionKey)) {
      if (candidate.childSessionKey?.trim() !== sessionKey) {
        continue;
      }
      for (const ancestorKey of [candidate.ownerKey, candidate.requesterSessionKey]) {
        const normalized = readNonEmptyString(ancestorKey);
        if (normalized && !keys.has(normalized)) {
          pending.push(normalized);
        }
      }
    }
  }

  return [...keys].toSorted();
}

/** Expand a direct mutation to every ancestor session activity view it affects. */
export function expandSessionActivityMutation(
  mutation: SessionActivityMutation,
): SessionActivityMutation[] {
  return listSessionActivityAncestorKeys([mutation.sessionKey]).map((sessionKey) =>
    sessionKey === mutation.sessionKey
      ? mutation
      : Object.assign(
          {
            sessionKey,
            revision: bumpSessionActivityRevision(sessionKey) ?? 0,
          },
          mutation.sourceSessionKey ? { sourceSessionKey: mutation.sourceSessionKey } : {},
        ),
  );
}

/**
 * Build a self-contained activity snapshot. Descendant traversal includes
 * terminal parent records so active grandchildren remain visible after an
 * intermediate parent task has finished.
 */
export function getSessionActivitySnapshot(params: {
  key: string;
  includeDescendants?: boolean;
}): SessionActivitySnapshot {
  const key = params.key.trim();
  const includeDescendants = params.includeDescendants !== false;
  const includedSessionKeys = new Set<string>();
  const taskById = new Map<string, TaskRecord>();
  const pending = key ? [key] : [];
  let truncated = false;

  while (pending.length > 0) {
    const sessionKey = pending.shift();
    if (!sessionKey || includedSessionKeys.has(sessionKey)) {
      continue;
    }
    if (includedSessionKeys.size >= MAX_SESSION_ACTIVITY_DESCENDANTS) {
      truncated = true;
      break;
    }
    includedSessionKeys.add(sessionKey);
    for (const task of listTasksForRelatedSessionKey(sessionKey)) {
      taskById.set(task.taskId, task);
      const childSessionKey = readNonEmptyString(task.childSessionKey);
      if (includeDescendants && childSessionKey && !includedSessionKeys.has(childSessionKey)) {
        pending.push(childSessionKey);
      }
    }
  }

  const sessionKeys = [...includedSessionKeys].toSorted();
  const tools = sessionKeys
    .flatMap((sessionKey) => listSessionToolActivities(sessionKey))
    .toSorted((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));

  return {
    key,
    revision: getSessionActivityRevision(key),
    includedSessionKeys: sessionKeys,
    truncated,
    tasks: [...taskById.values()].toSorted(compareTaskActivityNewestFirst),
    tools,
  };
}

/** Track live tool work separately from the durable detached-task ledger. */
export function recordSessionToolActivity(params: {
  event: AgentEventPayload;
  sessionKey: string | undefined;
}): SessionActivityMutation | undefined {
  if (params.event.stream !== "tool" || !params.sessionKey) {
    return undefined;
  }
  const sessionKey = params.sessionKey.trim();
  const data = params.event.data ?? {};
  const toolCallId = readNonEmptyString(data.toolCallId);
  if (!sessionKey || !toolCallId) {
    return undefined;
  }
  const id = `${params.event.runId}:${toolCallId}`;
  const phase = readNonEmptyString(data.phase);
  const state = getSessionActivityState();
  if (phase === "result") {
    const previous = state.toolsById.get(id);
    if (!previous) {
      return undefined;
    }
    state.toolsById.delete(id);
    emitPluginToolActivity({ activity: previous, phase: "finished" });
    return {
      sessionKey,
      revision: bumpSessionActivityRevision(sessionKey) ?? 0,
      sourceSessionKey: sessionKey,
    };
  }
  const previous = state.toolsById.get(id);
  const name = readNonEmptyString(data.name) ?? previous?.name ?? "tool";
  const now = typeof params.event.ts === "number" ? params.event.ts : Date.now();
  const activity: SessionToolActivity = {
    id,
    sessionKey,
    runId: params.event.runId,
    toolCallId,
    name,
    title: name,
    status: "running",
    startedAt: previous?.startedAt ?? now,
    updatedAt: now,
  };
  state.toolsById.set(id, activity);
  emitPluginToolActivity({ activity, phase: previous ? "updated" : "started" });
  return {
    sessionKey,
    revision: bumpSessionActivityRevision(sessionKey) ?? 0,
    sourceSessionKey: sessionKey,
  };
}

export function clearSessionToolActivitiesForRun(runId: string): SessionActivityMutation[] {
  const normalizedRunId = runId.trim();
  if (!normalizedRunId) {
    return [];
  }
  const state = getSessionActivityState();
  const changedSessionKeys = new Set<string>();
  for (const [id, activity] of state.toolsById) {
    if (activity.runId === normalizedRunId) {
      state.toolsById.delete(id);
      changedSessionKeys.add(activity.sessionKey);
      emitPluginToolActivity({ activity, phase: "finished" });
    }
  }
  return [...changedSessionKeys].toSorted().map((sessionKey) => ({
    sessionKey,
    revision: bumpSessionActivityRevision(sessionKey) ?? 0,
    sourceSessionKey: sessionKey,
  }));
}

export function listSessionToolActivities(sessionKey: string): SessionToolActivity[] {
  const normalizedSessionKey = sessionKey.trim();
  if (!normalizedSessionKey) {
    return [];
  }
  return [...getSessionActivityState().toolsById.values()]
    .filter((activity) => activity.sessionKey === normalizedSessionKey)
    .toSorted((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
    .map((activity) => Object.assign({}, activity));
}

export function resetSessionToolActivitiesForTests(): void {
  const state = getSessionActivityState();
  state.toolsById.clear();
  state.revisionsBySessionKey.clear();
}
