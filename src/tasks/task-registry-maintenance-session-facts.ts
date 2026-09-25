import type { resolveSessionStorePathCore } from "../config/sessions.js";
import type {
  readSessionBackingFacts,
  readSessionBackingFactsInWorker,
  SessionBackingFact,
} from "../config/sessions/session-accessor.js";
import { getAgentRunContext } from "../infra/agent-run-registry.js";
import type { parseAgentSessionKey } from "../routing/session-key.js";
import {
  deriveSessionChatTypeFromKey,
  type SessionKeyChatType,
} from "../sessions/session-chat-type-shared.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import type { TaskRecord } from "./task-registry.types.js";
import { getTaskRunOwner } from "./task-run-owner.js";

export type BackingSessionRuntime = {
  readSessionBackingFacts: typeof readSessionBackingFacts;
  readSessionBackingFactsInWorker: typeof readSessionBackingFactsInWorker;
  resolveStorePath: typeof resolveSessionStorePathCore;
  parseAgentSessionKey: typeof parseAgentSessionKey;
  deriveSessionChatTypeFromKey?: typeof deriveSessionChatTypeFromKey;
};

export type BackingSessionLookupContext = {
  runtime: BackingSessionRuntime;
  sessionEntriesByPath: Map<string, Map<string, SessionBackingFact | null | undefined>>;
  sessionChatTypesByKey: Map<string, SessionKeyChatType>;
  workerOnly: boolean;
  revision: number;
};

export function createBackingSessionLookupContext(
  runtime: BackingSessionRuntime,
  workerOnly = false,
): BackingSessionLookupContext {
  return {
    runtime,
    sessionEntriesByPath: new Map(),
    sessionChatTypesByKey: new Map(),
    workerOnly,
    revision: 0,
  };
}

function backingSessionTarget(task: TaskRecord, runtime: BackingSessionRuntime) {
  const sessionKey = task.childSessionKey?.trim();
  if (!sessionKey) {
    return undefined;
  }
  const agentId = runtime.parseAgentSessionKey(sessionKey)?.agentId;
  return {
    sessionKey,
    storePath: runtime.resolveStorePath(undefined, { agentId }),
  };
}

/** Acquire only keys requested by the runtime's existing liveness decision. */
export async function prepareBackingSessionFacts(
  context: BackingSessionLookupContext,
): Promise<void> {
  const scopes = [...context.sessionEntriesByPath].flatMap(([storePath, entries]) => {
    const sessionKeys = [...entries].flatMap(([key, entry]) => (entry === undefined ? [key] : []));
    return sessionKeys.length ? [{ storePath, sessionKeys }] : [];
  });
  if (scopes.length === 0) {
    return;
  }
  const revision = context.revision;
  const results = await context.runtime.readSessionBackingFactsInWorker(scopes);
  if (revision !== context.revision) {
    return;
  }
  for (const [index, scope] of scopes.entries()) {
    const facts = results[index];
    if (!facts) {
      continue;
    }
    const entries = context.sessionEntriesByPath.get(scope.storePath) ?? new Map();
    for (const key of scope.sessionKeys) {
      entries.set(key, null);
    }
    for (const fact of facts) {
      entries.set(fact.sessionKey, fact.entry);
    }
    context.sessionEntriesByPath.set(scope.storePath, entries);
  }
}

export function observeBackingSessionFacts(context: BackingSessionLookupContext): () => void {
  return sessionChanges.subscribe((change) => {
    context.revision += 1;
    if ("all" in change) {
      context.sessionEntriesByPath.clear();
    } else {
      for (const entries of context.sessionEntriesByPath.values()) {
        entries.delete(change.sessionKey);
      }
    }
  });
}

export function resolveSessionChatType(
  sessionKey: string,
  context: BackingSessionLookupContext,
): SessionKeyChatType {
  const derive = context.runtime.deriveSessionChatTypeFromKey ?? deriveSessionChatTypeFromKey;
  const cached = context.sessionChatTypesByKey.get(sessionKey);
  if (cached) {
    return cached;
  }
  const chatType = derive(sessionKey);
  context.sessionChatTypesByKey.set(sessionKey, chatType);
  return chatType;
}

export function findTaskSessionEntry(
  task: TaskRecord,
  context: BackingSessionLookupContext,
): SessionBackingFact | null | undefined {
  const target = backingSessionTarget(task, context.runtime);
  if (!target) {
    return null;
  }
  const entries = context.sessionEntriesByPath.get(target.storePath) ?? new Map();
  if (!entries.has(target.sessionKey)) {
    const facts = context.workerOnly
      ? undefined
      : context.runtime.readSessionBackingFacts({
          storePath: target.storePath,
          sessionKeys: [target.sessionKey],
        });
    entries.set(target.sessionKey, facts ? (facts[0]?.entry ?? null) : undefined);
    context.sessionEntriesByPath.set(target.storePath, entries);
  }
  // An unprepared or concurrently changed key is unknown, never evidence of death.
  return entries.get(target.sessionKey);
}

export function hasActiveCliRun(task: TaskRecord): boolean {
  if (getTaskRunOwner(task)) {
    return true;
  }
  const candidateRunIds = [task.sourceId, task.runId];
  for (const candidate of candidateRunIds) {
    const runId = candidate?.trim();
    if (runId && getAgentRunContext(runId)) {
      return true;
    }
  }
  return false;
}

export function hasCliRunIdentity(task: TaskRecord): boolean {
  return [task.sourceId, task.runId].some((candidate) => Boolean(candidate?.trim()));
}
